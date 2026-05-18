// ─── Memo Agent Context Builder ──────────────────────────────────────
// Gathers all deal data needed for memo generation.
// Parallel fetch with per-query .catch() so one failure never crashes all.

import { supabase } from '../../../supabase.js';
import { searchDocumentChunks, isRAGEnabled } from '../../../rag.js';
import { log } from '../../../utils/logger.js';
import { wrapDocumentContent } from '../guardrails.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface MemoContext {
  deal: {
    id: string;
    name: string;
    stage: string;
    status: string | null;
    industry: string | null;
    revenue: number | null;
    ebitda: number | null;
    dealSize: number | null;
    irrProjected: number | null;
    mom: number | null;
    aiThesis: string | null;
    description: string | null;
    source: string | null;
  } | null;
  company: {
    name: string | null;
    description: string | null;
    industry: string | null;
    website: string | null;
    founded: number | null;
    employees: number | null;
    headquarters: string | null;
  } | null;
  financials: Array<{
    statementType: string;
    period: string;
    lineItems: any;
    extractionConfidence: number | null;
    extractionSource: string | null;
    isActive: boolean;
  }>;
  documents: Array<{
    id: string;
    name: string;
    type: string | null;
    fileSize: number | null;
    isCIM: boolean;
    contentSummary: string | null;
  }>;
  activity: Array<{
    type: string;
    title: string;
    description: string | null;
    createdAt: string;
  }>;
  team: {
    leadPartner: string | null;
    analyst: string | null;
    members: Array<{ name: string; role: string }>;
  };
  dataAvailability: {
    hasFinancials: boolean;
    hasDocuments: boolean;
    hasDetailedDocs: boolean;
    hasCIM: boolean;
  };
}

// ─── CIM detection heuristics ─────────────────────────────────────────

function isCIMDocument(name: string, fileSize: number | null): boolean {
  const nameLower = name.toLowerCase();
  if (
    nameLower.includes('cim') ||
    nameLower.includes('confidential information memorandum') ||
    nameLower.includes('offering memorandum') ||
    nameLower.includes('information memorandum') ||
    nameLower.includes('im ') ||
    nameLower.endsWith(' im') ||
    nameLower.includes('teaser')
  ) {
    return true;
  }
  // Large PDFs (>500KB) that mention "memorandum" or "investment" in name
  if (fileSize && fileSize > 500_000) {
    if (
      nameLower.includes('memorandum') ||
      nameLower.includes('investment') ||
      nameLower.includes('overview')
    ) {
      return true;
    }
  }
  return false;
}

// ─── Main context builder ─────────────────────────────────────────────

export async function buildMemoContext(dealId: string, orgId: string): Promise<MemoContext> {
  log.info('Building memo context', { dealId, orgId });

  // Parallel fetch — each wrapped in .catch() so one failure never crashes all
  const [dealResult, financialsResult, documentsResult, activityResult, teamResult] = await Promise.all([

    // 1. Deal + Company
    supabase
      .from('Deal')
      .select(`
        id, name, stage, status, industry, revenue, ebitda, dealSize,
        irrProjected, mom, aiThesis, description, source,
        company:Company(name, description, industry, website, founded, employees, headquarters)
      `)
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single()
      .then(r => r, (err: any) => {
        log.warn('Memo context: deal fetch failed', { dealId, err: err?.message });
        return { data: null, error: err } as any;
      }),

    // 2. Financial statements (all active, most recent first)
    supabase
      .from('FinancialStatement')
      .select('statementType, period, lineItems, extractionConfidence, extractionSource, isActive')
      .eq('dealId', dealId)
      .eq('isActive', true)
      .order('period', { ascending: false })
      .limit(30)
      .then(r => r, (err: any) => {
        log.warn('Memo context: financials fetch failed', { dealId, err: err?.message });
        return { data: [], error: err } as any;
      }),

    // 3. Documents — metadata + extracted text for summarisation
    supabase
      .from('Document')
      .select('id, name, type, fileSize, extractedText, mimeType')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false })
      .limit(20)
      .then(r => r, (err: any) => {
        log.warn('Memo context: documents fetch failed', { dealId, err: err?.message });
        return { data: [], error: err } as any;
      }),

    // 4. Recent activity
    supabase
      .from('Activity')
      .select('type, title, description, createdAt')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false })
      .limit(20)
      .then(r => r, (err: any) => {
        log.warn('Memo context: activity fetch failed', { dealId, err: err?.message });
        return { data: [], error: err } as any;
      }),

    // 5. Deal team members with user names
    supabase
      .from('DealTeamMember')
      .select('role, user:User(firstName, lastName, email)')
      .eq('dealId', dealId)
      .then(r => r, (err: any) => {
        log.warn('Memo context: team fetch failed', { dealId, err: err?.message });
        return { data: [], error: err } as any;
      }),
  ]);

  // ── Unpack deal + company ───────────────────────────────────────────

  const rawDeal = (dealResult as any).data;
  const deal = rawDeal
    ? {
        id: rawDeal.id,
        name: rawDeal.name,
        stage: rawDeal.stage,
        status: rawDeal.status ?? null,
        industry: rawDeal.industry ?? null,
        revenue: rawDeal.revenue ?? null,
        ebitda: rawDeal.ebitda ?? null,
        dealSize: rawDeal.dealSize ?? null,
        irrProjected: rawDeal.irrProjected ?? null,
        mom: rawDeal.mom ?? null,
        aiThesis: rawDeal.aiThesis ?? null,
        description: rawDeal.description ?? null,
        source: rawDeal.source ?? null,
      }
    : null;

  const rawCompany = rawDeal?.company ?? null;
  const company = rawCompany
    ? {
        name: rawCompany.name ?? null,
        description: rawCompany.description ?? null,
        industry: rawCompany.industry ?? null,
        website: rawCompany.website ?? null,
        founded: rawCompany.founded ?? null,
        employees: rawCompany.employees ?? null,
        headquarters: rawCompany.headquarters ?? null,
      }
    : null;

  // ── Financials ──────────────────────────────────────────────────────

  const financials: MemoContext['financials'] = ((financialsResult as any).data || []).map((s: any) => ({
    statementType: s.statementType,
    period: s.period,
    lineItems: s.lineItems,
    extractionConfidence: s.extractionConfidence ?? null,
    extractionSource: s.extractionSource ?? null,
    isActive: s.isActive,
  }));

  // ── Documents — enrich with content summary ─────────────────────────

  const rawDocs: any[] = (documentsResult as any).data || [];

  // Try RAG search for broad topic to pull key content; fall back to extractedText slice
  let ragChunks: any[] = [];
  if (isRAGEnabled() && rawDocs.length > 0) {
    ragChunks = await searchDocumentChunks(
      'business overview revenue EBITDA investment thesis risks',
      dealId,
      10,
      0.3,
    ).catch(() => []);
  }

  // Build a map of docId → RAG content snippets
  const ragByDocId: Record<string, string[]> = {};
  for (const chunk of ragChunks) {
    const docId = chunk.metadata?.documentId || chunk.documentId;
    if (docId) {
      ragByDocId[docId] = ragByDocId[docId] || [];
      ragByDocId[docId].push(chunk.content || chunk.pageContent || '');
    }
  }

  const documents: MemoContext['documents'] = rawDocs.map((doc: any) => {
    const cim = isCIMDocument(doc.name, doc.fileSize ?? null);
    let contentSummary: string | null = null;

    // Prefer RAG chunks for this document
    const ragSnippets = ragByDocId[doc.id];
    if (ragSnippets && ragSnippets.length > 0) {
      contentSummary = ragSnippets.join('\n\n').slice(0, 3000);
    } else if (doc.extractedText) {
      // Fallback: first 3000 chars of raw extracted text
      contentSummary = (doc.extractedText as string).slice(0, 3000);
    }

    return {
      id: doc.id,
      name: doc.name,
      type: doc.type ?? null,
      fileSize: doc.fileSize ?? null,
      isCIM: cim,
      contentSummary,
    };
  });

  // ── Activity ────────────────────────────────────────────────────────

  const activity: MemoContext['activity'] = ((activityResult as any).data || []).map((a: any) => ({
    type: a.type,
    title: a.title,
    description: a.description ?? null,
    createdAt: a.createdAt,
  }));

  // ── Team ────────────────────────────────────────────────────────────

  const rawTeam: any[] = (teamResult as any).data || [];
  let leadPartner: string | null = null;
  let analyst: string | null = null;
  const members: Array<{ name: string; role: string }> = [];

  for (const member of rawTeam) {
    const user = member.user as any;
    if (!user) continue;
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Unknown';
    members.push({ name, role: member.role });
    if (member.role === 'LEAD') leadPartner = name;
    if (member.role === 'MEMBER' && !analyst) analyst = name;
  }

  // ── Data availability flags ─────────────────────────────────────────

  const hasCIM = documents.some((d) => d.isCIM);
  const hasDetailedDocs = documents.some((d) => d.contentSummary && d.contentSummary.length > 200);

  const dataAvailability: MemoContext['dataAvailability'] = {
    hasFinancials: financials.length > 0,
    hasDocuments: documents.length > 0,
    hasDetailedDocs,
    hasCIM,
  };

  log.info('Memo context built', {
    dealId,
    financials: financials.length,
    documents: documents.length,
    hasCIM,
    hasDetailedDocs,
    teamMembers: members.length,
  });

  return {
    deal,
    company,
    financials,
    documents,
    activity,
    team: { leadPartner, analyst, members },
    dataAvailability,
  };
}

// ─── Format context for LLM consumption ──────────────────────────────

export function formatContextForLLM(ctx: MemoContext): string {
  const parts: string[] = [];

  // ── Deal overview ─────────────────────────────────────────────────

  if (ctx.deal) {
    const d = ctx.deal;
    parts.push(`## DEAL OVERVIEW`);
    parts.push(`Name: ${d.name}`);
    parts.push(`Stage: ${d.stage}${d.status ? ` (${d.status})` : ''}`);
    if (d.industry) parts.push(`Industry: ${d.industry}`);
    if (d.source) parts.push(`Source: ${d.source}`);
    if (d.revenue) parts.push(`Revenue: $${d.revenue}M`);
    if (d.ebitda) parts.push(`EBITDA: $${d.ebitda}M`);
    if (d.dealSize) parts.push(`Deal Size: $${d.dealSize}M`);
    if (d.irrProjected) parts.push(`Projected IRR: ${d.irrProjected}%`);
    if (d.mom) parts.push(`MoM: ${d.mom}x`);
    if (d.aiThesis) parts.push(`Investment Thesis: ${d.aiThesis}`);
    if (d.description) parts.push(`Description: ${d.description}`);
  }

  // ── Company ───────────────────────────────────────────────────────

  if (ctx.company) {
    const c = ctx.company;
    parts.push(`\n## COMPANY`);
    if (c.name) parts.push(`Name: ${c.name}`);
    if (c.industry) parts.push(`Industry: ${c.industry}`);
    if (c.description) parts.push(`Description: ${c.description}`);
    if (c.website) parts.push(`Website: ${c.website}`);
    if (c.founded) parts.push(`Founded: ${c.founded}`);
    if (c.employees) parts.push(`Employees: ${c.employees.toLocaleString()}`);
    if (c.headquarters) parts.push(`HQ: ${c.headquarters}`);
  }

  // ── Financial statements ──────────────────────────────────────────

  if (ctx.financials.length > 0) {
    parts.push(`\n## FINANCIAL STATEMENTS (${ctx.financials.length} periods)`);

    // Group by statement type
    const byType: Record<string, typeof ctx.financials> = {};
    for (const s of ctx.financials) {
      byType[s.statementType] = byType[s.statementType] || [];
      byType[s.statementType].push(s);
    }

    for (const [type, stmts] of Object.entries(byType)) {
      parts.push(`\n### ${type}`);
      for (const s of stmts.slice(0, 5)) {
        const items = s.lineItems && typeof s.lineItems === 'object' ? s.lineItems : {};
        const entries = Object.entries(items).filter(([, v]) => v !== null && v !== undefined);
        parts.push(`\nPeriod: ${s.period} (${entries.length} line items, confidence: ${s.extractionConfidence ?? 'N/A'}%)`);
        for (const [label, value] of entries.slice(0, 20)) {
          parts.push(`  ${label}: $${value}M`);
        }
      }
    }
  } else {
    parts.push(`\n## FINANCIAL STATEMENTS\nNo financial statements extracted yet.`);
  }

  // ── Documents ─────────────────────────────────────────────────────

  if (ctx.documents.length > 0) {
    parts.push(`\n## DOCUMENTS (${ctx.documents.length} uploaded)`);
    for (const doc of ctx.documents) {
      const cimTag = doc.isCIM ? ' [CIM]' : '';
      const sizeKB = doc.fileSize ? ` (${Math.round(doc.fileSize / 1024)}KB)` : '';
      parts.push(`\n### ${doc.name}${cimTag}${sizeKB}`);
      if (doc.contentSummary) {
        // Wrap user-uploaded document body in <document> delimiters
        // so the model treats it as untrusted data (Task 4.7).
        parts.push(wrapDocumentContent(doc.contentSummary.slice(0, 2000), doc.name));
      }
    }
  } else {
    parts.push(`\n## DOCUMENTS\nNo documents uploaded yet.`);
  }

  // ── Activity ──────────────────────────────────────────────────────

  if (ctx.activity.length > 0) {
    parts.push(`\n## RECENT ACTIVITY`);
    for (const a of ctx.activity.slice(0, 10)) {
      const date = new Date(a.createdAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      parts.push(`- [${date}] ${a.type}: ${a.title}${a.description ? ` — ${a.description}` : ''}`);
    }
  }

  // ── Team ──────────────────────────────────────────────────────────

  if (ctx.team.members.length > 0) {
    parts.push(`\n## DEAL TEAM`);
    if (ctx.team.leadPartner) parts.push(`Lead Partner: ${ctx.team.leadPartner}`);
    if (ctx.team.analyst) parts.push(`Analyst: ${ctx.team.analyst}`);
    for (const m of ctx.team.members) {
      if (m.role !== 'LEAD' && m.role !== 'MEMBER') {
        parts.push(`${m.role}: ${m.name}`);
      }
    }
  }

  // ── Data availability summary ─────────────────────────────────────

  const avail = ctx.dataAvailability;
  parts.push(`\n## DATA AVAILABILITY`);
  parts.push(`Financials: ${avail.hasFinancials ? 'YES' : 'NO'}`);
  parts.push(`Documents: ${avail.hasDocuments ? 'YES' : 'NO'}${avail.hasDetailedDocs ? ' (with extracted text)' : ''}`);
  parts.push(`CIM: ${avail.hasCIM ? 'YES' : 'NO'}`);

  return parts.join('\n');
}
