// ─── Inbox Deal Scan service ───────────────────────────────────────
// Powers the dashboard "Scan inbox for deals" action. Reads the current
// user's Gmail, AI-extracts potential deal info from recent sourcing /
// intro emails, and returns CANDIDATES for the user to review.
//
// REVIEW-FIRST: this service NEVER writes to the database — no Deal rows,
// no Company rows, nothing. The frontend creates a Deal via POST /api/deals
// only after the user confirms a candidate.
//
// Patterns (token refresh, internal-user resolution, bounded concurrency)
// are copied from agents/dealChatAgent/tools/getRecentEmailsForDeal.ts.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  getDecryptedTokens,
  saveTokens,
  markStatus,
} from '../integrations/_platform/tokenStore.js';
import {
  getAttachment,
  getMessageFull,
  listRecentDealCandidates,
  refreshAccessToken,
} from '../integrations/gmail/client.js';
import type { Integration } from '../integrations/_platform/types.js';
import type { GmailMessageFull } from '../integrations/gmail/types.js';
import { extractDealDataFromText } from './aiExtractor.js';
import { extractTextFromPDF } from './pdfExtractor.js';
import {
  scoreDealSignals,
  priorityRank,
  LLM_EXTRACTION_GATE,
  type DealPriority,
} from './inboxDealSignals.js';

// ─── Tunables (no magic numbers) ───────────────────────────────────
const LOOKBACK_DAYS_DEFAULT = 14;
const LOOKBACK_DAYS_MIN = 1;
const LOOKBACK_DAYS_MAX = 60;
const MAX_SCAN_EMAILS = 25;
const EXTRACT_CONCURRENCY = 4;
// Per-field confidence floor — same gate as the ingest routes. Only surface
// revenue/ebitda/dealSize when the extractor is at least this confident.
const FIELD_FLOOR = 60;
// A candidate must clear this overall confidence to be worth showing for review.
const MIN_CANDIDATE_CONFIDENCE = 40;
// Lower bar for emails that carry a deal-document attachment (CIM/teaser/IM):
// the attachment itself is a strong deal signal, so surface a borderline
// extraction for review rather than dropping it.
const MIN_CANDIDATE_CONFIDENCE_WITH_ATTACHMENT = 25;
// Extraction text shorter than this is too thin to bother the LLM with.
const MIN_EXTRACT_TEXT_LEN = 100;
const TOKEN_REFRESH_SAFETY_MS = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// PDF attachment handling — teasers/CIMs often ARE the attached PDF, so pull
// their text too. Bounded to keep a synchronous dashboard scan fast + cheap.
const MAX_PDF_ATTACHMENTS_PER_EMAIL = 2;
const MAX_PDF_BYTES = 15 * 1024 * 1024; // skip giant pitch decks
const MAX_PDF_TEXT_CHARS = 8000; // cap added per email to bound LLM token cost
// Overall wall-clock budget for ALL PDF download+parse work across the whole
// scan. Big decks can hang a synchronous dashboard "Scan inbox"; once this
// shared deadline passes we stop fetching/parsing attachments and fall back to
// body text only. Tracked as an unread attachment so the user is told.
const PDF_WORK_BUDGET_MS = 20_000;
// Overall cap on bytes downloaded for PDF parsing across the whole scan — a
// second guard rail alongside the time budget so a few mid-sized decks can't
// blow up memory / bandwidth even if they each parse quickly.
const PDF_TOTAL_BYTES_BUDGET = 40 * 1024 * 1024;
// Extracted PDF text shorter than this is treated as "couldn't read" (scanned /
// image-only decks return little or no text from pdf-parse).
const MIN_PDF_TEXT_LEN = 64;

// ─── Public types ──────────────────────────────────────────────────

export interface InboxDealCandidate {
  emailId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  companyName: string;
  industry: string | null;
  description: string;
  summary: string;
  currency: string;
  revenue: number | null; // millions, null if confidence < FIELD_FLOOR
  ebitda: number | null; // millions, null if confidence < FIELD_FLOOR
  dealSize: number | null; // millions, null if confidence < FIELD_FLOOR
  overallConfidence: number;
  reviewReasons: string[];
  // Explainable pickup signals (inboxDealSignals.ts) — the "why this email was
  // picked up, and at what priority" breakdown shown in the widget.
  signalScore: number; // 0–100
  priority: DealPriority; // 'high' | 'medium' | 'low'
  signals: string[]; // matched deal signals, strongest first
}

// Compact, user-facing summary of how the scan triaged the inbox — powers the
// "here's what the scan did" line in the Inbox Deal Finder widget.
export interface InboxScanProcess {
  scanned: number; // emails fetched from the keyword-scoped Gmail query
  skippedLowSignal: number; // fetched but gated out before the LLM (noise)
  high: number; // surfaced candidates by priority
  medium: number;
  low: number;
}

// ─── Live progress events ──────────────────────────────────────────
// Emitted through the optional `onEvent` callback so the streaming route can
// relay a terminal-style, real-time log of exactly which emails the scan sees,
// scores, extracts, and surfaces — the user watches new mail get picked up.
export type ScanEvent =
  | { t: 'status'; msg: string }
  | { t: 'listed'; count: number; lookbackDays: number }
  | { t: 'email'; subject: string; from: string; score: number; priority: DealPriority; gated: boolean; signals: string[] }
  | { t: 'extract'; subject: string }
  | { t: 'candidate'; company: string; priority: DealPriority; confidence: number }
  | { t: 'skip'; subject: string; reason: string }
  | { t: 'result'; result: InboxScanResult }
  | { t: 'error'; msg: string };

export interface InboxScanResult {
  connected: boolean;
  scanned: number;
  candidates: InboxDealCandidate[];
  process?: InboxScanProcess;
  // Count of PDF attachments that existed on scanned emails but yielded no
  // usable text — scanned/image-only PDFs (pdf-parse returns ~nothing), files
  // that threw, oversized files, or attachments skipped once the PDF time/byte
  // budget was exhausted. Surfaced so a silently-empty deck is visible to the
  // user instead of vanishing.
  attachmentsUnread: number;
}

// ─── Internal helpers (replicated locally — no routes→services coupling) ──

/** Run an async mapper across `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Resolve auth UUID (req.user?.id) to the internal User.id used as
 * Integration.userId. Integrations are keyed on the internal id.
 */
async function resolveInternalUserId(authOrInternalId: string): Promise<string | null> {
  // First try as authId (the common case from req.user.id)
  const { data: byAuth } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authOrInternalId)
    .maybeSingle();
  if (byAuth?.id) return byAuth.id as string;
  // Fall back: caller may have passed the internal id already
  const { data: byId } = await supabase
    .from('User')
    .select('id')
    .eq('id', authOrInternalId)
    .maybeSingle();
  return (byId?.id as string | undefined) ?? null;
}

/**
 * Fetch a fresh access token for this integration, refreshing if expired.
 * Returns null (and marks status='error') when the connection is unusable —
 * callers map that to `connected: false`.
 */
async function ensureFreshGmailToken(integration: Integration): Promise<string | null> {
  const { accessToken, refreshToken } = await getDecryptedTokens(integration);
  if (!accessToken) return null;

  const expiresAt = integration.tokenExpiresAt ? Date.parse(integration.tokenExpiresAt) : 0;
  const now = Date.now();
  if (!expiresAt || expiresAt - now > TOKEN_REFRESH_SAFETY_MS) {
    return accessToken;
  }
  if (!refreshToken) {
    await markStatus(integration.id, 'error', 'no refresh token').catch(() => {});
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await saveTokens({
      integrationId: integration.id,
      accessToken: refreshed.access_token,
      refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn('inboxDealScan: gmail token refresh failed', { integrationId: integration.id, msg });
    await markStatus(integration.id, 'error', `refresh failed: ${msg}`).catch(() => {});
    return null;
  }
}

/** Load existing org company names, lowercased+trimmed, for dedupe. */
async function loadExistingCompanyNames(orgId: string): Promise<Set<string>> {
  const set = new Set<string>();
  const { data, error } = await supabase
    .from('Company')
    .select('name')
    .eq('organizationId', orgId);
  if (error) {
    log.warn('inboxDealScan: existing company lookup failed', { orgId, message: error.message });
    return set;
  }
  for (const row of (data ?? []) as Array<{ name: string | null }>) {
    const name = (row.name ?? '').trim().toLowerCase();
    if (name) set.add(name);
  }
  return set;
}

// Per-field gate: surface a financial value only when present AND the
// extractor's confidence for that field clears the floor.
function gateFinancial(field: { value: number | null; confidence: number }): number | null {
  return field.value != null && field.confidence >= FIELD_FLOOR ? field.value : null;
}

// Filename fragments that mark an attachment as a deal document (CIM, teaser,
// information memorandum). An email carrying one is a strong deal signal even
// when its body has no deal language, so we prioritise it for PDF extraction and
// hold it to a lower confidence bar when building candidates.
const DEAL_ATTACHMENT_NAME_RE =
  /\b(cim|teaser|information\s+memorandum|info\s*memo|memorandum|ioi)\b/i;

/** The first deal-document attachment filename on a message, or null. */
function dealAttachmentName(message: GmailMessageFull): string | null {
  for (const a of message.attachments) {
    if (a.filename && DEAL_ATTACHMENT_NAME_RE.test(a.filename)) return a.filename;
  }
  return null;
}

/**
 * Shared, mutable PDF-work budget threaded through every per-message call to
 * `extractPdfAttachmentsText`. The scan runs the per-message mapper with bounded
 * concurrency, so all workers read/mutate this single object to enforce ONE
 * wall-clock deadline and ONE total-bytes cap across the whole scan.
 */
interface PdfWorkBudget {
  /** Absolute wall-clock deadline (epoch ms). Past this: stop all PDF work. */
  deadlineAt: number;
  /** Bytes downloaded for PDF parsing so far (across all messages). */
  bytesUsed: number;
  /** Running count of PDF attachments that existed but yielded no usable text. */
  attachmentsUnread: number;
}

function makePdfWorkBudget(): PdfWorkBudget {
  return { deadlineAt: Date.now() + PDF_WORK_BUDGET_MS, bytesUsed: 0, attachmentsUnread: 0 };
}

/**
 * Pull text from a message's PDF attachments (teasers/CIMs are frequently the
 * attachment, not the body). Uses the lightweight pdf-parse extractor — this is
 * a first-look candidate scan, so the high-fidelity LlamaParse pass is left to
 * the real ingest pipeline that runs when the user confirms a candidate.
 *
 * Bounded by per-email count, per-file byte size, and total chars — AND by a
 * shared, scan-wide time + bytes budget (see PdfWorkBudget). Once the budget is
 * exhausted we stop fetching/parsing and fall back to body text only. Every PDF
 * that existed but produced no usable text (scanned/image-only, threw,
 * oversized, or skipped by budget) bumps `budget.attachmentsUnread`.
 */
async function extractPdfAttachmentsText(
  accessToken: string,
  message: GmailMessageFull,
  budget: PdfWorkBudget,
): Promise<string> {
  const pdfs = message.attachments
    .filter(
      (a) =>
        a.attachmentId &&
        (a.mimeType === 'application/pdf' || a.filename.toLowerCase().endsWith('.pdf'))
    )
    .slice(0, MAX_PDF_ATTACHMENTS_PER_EMAIL);
  if (pdfs.length === 0) return '';

  const chunks: string[] = [];
  for (const att of pdfs) {
    // Budget exhausted (time or bytes): skip this and every remaining PDF, but
    // count each as unread so the email isn't silently dropped.
    if (Date.now() >= budget.deadlineAt || budget.bytesUsed >= PDF_TOTAL_BYTES_BUDGET) {
      log.info('inboxDealScan: PDF budget exhausted — skipping attachment', {
        messageId: message.id,
        filename: att.filename,
        bytesUsed: budget.bytesUsed,
      });
      budget.attachmentsUnread++;
      continue;
    }
    if (att.size && att.size > MAX_PDF_BYTES) {
      log.info('inboxDealScan: skipping oversized PDF attachment', {
        messageId: message.id,
        filename: att.filename,
        size: att.size,
      });
      budget.attachmentsUnread++;
      continue;
    }
    // Don't start a download that would blow past the total-bytes budget.
    if (att.size && budget.bytesUsed + att.size > PDF_TOTAL_BYTES_BUDGET) {
      log.info('inboxDealScan: PDF total-bytes budget would be exceeded — skipping', {
        messageId: message.id,
        filename: att.filename,
        size: att.size,
        bytesUsed: budget.bytesUsed,
      });
      budget.attachmentsUnread++;
      continue;
    }
    try {
      const buffer = await getAttachment(accessToken, message.id, att.attachmentId);
      budget.bytesUsed += buffer.length;
      const extracted = await extractTextFromPDF(buffer);
      const text = extracted?.text?.replace(/\u0000/g, '').trim();
      if (text && text.length >= MIN_PDF_TEXT_LEN) {
        chunks.push(text);
      } else {
        // Existed but unreadable (scanned/image-only deck → little/no text).
        budget.attachmentsUnread++;
      }
    } catch (err) {
      budget.attachmentsUnread++;
      log.warn('inboxDealScan: PDF attachment extract failed (skipping)', {
        messageId: message.id,
        filename: att.filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let combined = chunks.join('\n\n').trim();
  if (combined.length > MAX_PDF_TEXT_CHARS) {
    combined = combined.slice(0, MAX_PDF_TEXT_CHARS) + '…';
  }
  return combined;
}

// ─── Entry point ───────────────────────────────────────────────────

export async function scanInboxForDeals(args: {
  orgId: string;
  authUserId: string;
  lookbackDays?: number;
  // Optional progress sink — the streaming route feeds each event to the client
  // as a terminal log line. No-op for the plain (buffered) endpoint.
  onEvent?: (ev: ScanEvent) => void;
}): Promise<InboxScanResult> {
  const { orgId, authUserId } = args;
  const emit = (ev: ScanEvent) => {
    try {
      args.onEvent?.(ev);
    } catch {
      // A broken client stream must never break the scan itself.
    }
  };
  const notConnected: InboxScanResult = {
    connected: false,
    scanned: 0,
    candidates: [],
    attachmentsUnread: 0,
  };

  // 1. Clamp lookback to [1, 60], default 14.
  const lookbackDays = Math.min(
    Math.max(args.lookbackDays ?? LOOKBACK_DAYS_DEFAULT, LOOKBACK_DAYS_MIN),
    LOOKBACK_DAYS_MAX
  );

  // 2. Resolve internal user id.
  const internalUserId = await resolveInternalUserId(authUserId);
  if (!internalUserId) {
    log.info('inboxDealScan: no internal user for auth id — gmail not connected', { orgId });
    return notConnected;
  }

  // 3. Load the connected Gmail integration (keyed on internal user id).
  const { data: integration } = await supabase
    .from('Integration')
    .select('*')
    .eq('userId', internalUserId)
    .eq('provider', 'gmail')
    .eq('status', 'connected')
    .maybeSingle();
  if (!integration) {
    log.info('inboxDealScan: no connected gmail integration', { orgId, internalUserId });
    return notConnected;
  }

  emit({ t: 'status', msg: 'Connecting to Gmail…' });

  // 4. Ensure a fresh access token.
  const accessToken = await ensureFreshGmailToken(integration as Integration);
  if (!accessToken) {
    log.info('inboxDealScan: gmail token unavailable', { orgId, internalUserId });
    return notConnected;
  }

  // 5. List recent deal-candidate emails (broad keyword scope, no contacts needed).
  emit({ t: 'status', msg: `Searching inbox — last ${lookbackDays} days…` });
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);
  const headers = await listRecentDealCandidates(accessToken, since, MAX_SCAN_EMAILS);
  emit({ t: 'listed', count: headers.length, lookbackDays });
  if (headers.length === 0) {
    log.info('inboxDealScan: no candidate emails in window', { orgId, lookbackDays });
    return { connected: true, scanned: 0, candidates: [], attachmentsUnread: 0 };
  }

  // 6. Fetch full bodies with bounded concurrency; drop per-message failures.
  const fetched = await mapWithConcurrency<{ id: string; threadId: string }, GmailMessageFull | null>(
    headers,
    EXTRACT_CONCURRENCY,
    async (h) => {
      try {
        return await getMessageFull(accessToken, h.id);
      } catch (err) {
        log.warn('inboxDealScan: per-message fetch failed (skipping)', {
          messageId: h.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
  );
  const messages = fetched.filter((m): m is GmailMessageFull => m !== null);
  if (messages.length === 0) {
    return { connected: true, scanned: 0, candidates: [], attachmentsUnread: 0 };
  }

  // Score each message's deal-signal strength (cheap, no LLM) from its subject,
  // body/snippet, and attachment filenames. This is the PRECISION gate: the
  // Gmail query casts a wide net for recall, and this drops the emails that only
  // brushed a keyword (a newsletter that says "for sale") before we spend an LLM
  // call on them — which is what stops the scan "picking up randomly". It also
  // yields the priority + human-readable breakdown surfaced in the widget.
  emit({ t: 'status', msg: `Scoring ${messages.length} email${messages.length === 1 ? '' : 's'} for deal signals…` });
  const signalByMsgId = new Map<string, ReturnType<typeof scoreDealSignals>>();
  const dealAttachByMsgId = new Map<string, string | null>();
  for (const m of messages) {
    dealAttachByMsgId.set(m.id, dealAttachmentName(m));
    const signal = scoreDealSignals({
      subject: m.headers.Subject || '',
      body: m.body || m.snippet || '',
      attachmentNames: m.attachments.map((a) => a.filename).filter(Boolean),
    });
    signalByMsgId.set(m.id, signal);
    emit({
      t: 'email',
      subject: m.headers.Subject || '(no subject)',
      from: m.headers.From || 'unknown',
      score: signal.score,
      priority: signal.priority,
      gated: signal.score < LLM_EXTRACTION_GATE,
      signals: signal.signals,
    });
  }

  // Gate out low-signal noise before the LLM; keep a count so the widget can
  // show "N skipped as low-signal" instead of silently discarding them.
  const toExtract = messages.filter(
    (m) => (signalByMsgId.get(m.id)?.score ?? 0) >= LLM_EXTRACTION_GATE,
  );
  const skippedLowSignal = messages.length - toExtract.length;
  emit({
    t: 'status',
    msg: `${toExtract.length} passed the signal gate · ${skippedLowSignal} skipped — extracting with AI…`,
  });

  // Highest-signal emails first — they get first claim on the shared PDF-work
  // budget (their decks are the ones worth parsing) and are extracted first.
  toExtract.sort(
    (a, b) => (signalByMsgId.get(b.id)?.score ?? 0) - (signalByMsgId.get(a.id)?.score ?? 0),
  );

  // 7. Existing org company names for dedupe.
  const existingNames = await loadExistingCompanyNames(orgId);

  // 8. Build extraction text per message and run the extractor (bounded concurrency).
  // One shared PDF-work budget for the whole scan: a single wall-clock deadline
  // (~20s) + total-bytes cap across all messages, so big decks can't hang the
  // dashboard "Scan inbox". Workers mutate it as they go.
  const pdfBudget = makePdfWorkBudget();
  type Extracted = { message: GmailMessageFull; data: Awaited<ReturnType<typeof extractDealDataFromText>> };
  const extracted = await mapWithConcurrency<GmailMessageFull, Extracted | null>(
    toExtract,
    EXTRACT_CONCURRENCY,
    async (m) => {
      const subject = m.headers.Subject || '(no subject)';
      const from = m.headers.From || 'unknown';
      const bodyText = m.body || m.snippet || '';
      emit({ t: 'extract', subject });

      // Teasers/CIMs often arrive AS a PDF with a near-empty body — pull the
      // attachment text so those emails clear the length floor below.
      const pdfText = await extractPdfAttachmentsText(accessToken, m, pdfBudget);

      const segments = [`Subject: ${subject}`, `From: ${from}`, '', bodyText];
      if (pdfText) segments.push('', '--- Attached document ---', pdfText);
      const text = segments.join('\n');
      if (text.trim().length < MIN_EXTRACT_TEXT_LEN) return null;
      try {
        const data = await extractDealDataFromText(text);
        if (!data) return null;
        return { message: m, data };
      } catch (err) {
        log.warn('inboxDealScan: extraction failed (skipping)', {
          messageId: m.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
  );

  // 9. Build candidates with dedupe + per-field confidence gating.
  const candidates: InboxDealCandidate[] = [];
  for (const item of extracted) {
    if (!item || !item.data) continue;
    const { message, data } = item;

    const subject = message.headers.Subject || '(no subject)';
    const companyName = (data.companyName.value ?? '').trim();
    if (!companyName) {
      emit({ t: 'skip', subject, reason: 'no company name found' });
      continue;
    }

    // A deal-document attachment (CIM/teaser/IM) is itself a strong signal, so
    // hold such emails to a lower confidence bar than a plain body-only email.
    const attachmentName = dealAttachByMsgId.get(message.id) ?? null;
    const confidenceFloor = attachmentName
      ? MIN_CANDIDATE_CONFIDENCE_WITH_ATTACHMENT
      : MIN_CANDIDATE_CONFIDENCE;
    if (data.overallConfidence < confidenceFloor) {
      emit({ t: 'skip', subject, reason: `low extraction confidence (${data.overallConfidence}%)` });
      continue;
    }

    // Dedupe against existing org companies AND across this scan's candidates.
    const key = companyName.toLowerCase();
    if (existingNames.has(key)) {
      emit({ t: 'skip', subject, reason: `"${companyName}" already exists` });
      continue;
    }
    existingNames.add(key);

    const reviewReasons = Array.isArray(data.reviewReasons) ? [...data.reviewReasons] : [];
    if (attachmentName) {
      reviewReasons.unshift(`Deal document attached: ${attachmentName}`);
    }

    const signal = signalByMsgId.get(message.id);
    emit({
      t: 'candidate',
      company: companyName,
      priority: signal?.priority ?? 'low',
      confidence: data.overallConfidence,
    });
    candidates.push({
      emailId: message.id,
      threadId: message.threadId,
      subject: message.headers.Subject || '(no subject)',
      from: message.headers.From || 'unknown',
      date: message.headers.Date || '',
      snippet: message.snippet || '',
      companyName,
      industry: data.industry.value ?? null,
      description: data.description.value ?? '',
      summary: data.summary ?? '',
      currency: data.currency || 'USD',
      revenue: gateFinancial(data.revenue),
      ebitda: gateFinancial(data.ebitda),
      dealSize: gateFinancial(data.dealSize),
      overallConfidence: data.overallConfidence,
      reviewReasons,
      signalScore: signal?.score ?? 0,
      priority: signal?.priority ?? 'low',
      signals: signal?.signals ?? [],
    });
  }

  // 10. Sort by priority tier first, then signal strength, then extraction
  // confidence — so the strongest, most-clearly-a-deal emails sit at the top.
  candidates.sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.signalScore - a.signalScore ||
      b.overallConfidence - a.overallConfidence,
  );

  const scanProcess: InboxScanProcess = {
    scanned: messages.length,
    skippedLowSignal,
    high: candidates.filter((c) => c.priority === 'high').length,
    medium: candidates.filter((c) => c.priority === 'medium').length,
    low: candidates.filter((c) => c.priority === 'low').length,
  };

  log.info('inboxDealScan: complete', {
    orgId,
    candidates: candidates.length,
    ...scanProcess,
    attachmentsUnread: pdfBudget.attachmentsUnread,
  });

  // 11. Done.
  return {
    connected: true,
    scanned: messages.length,
    candidates,
    process: scanProcess,
    attachmentsUnread: pdfBudget.attachmentsUnread,
  };
}
