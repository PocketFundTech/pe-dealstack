// ─── search_documents tool (ORG-WIDE) ─────────────────────────────
// Cross-deal document / data-room search. The per-deal agent's
// search_documents is scoped to a single dealId; this org-wide version
// searches across EVERY deal in the organization and labels each hit with
// its source deal so the user knows which company a snippet came from.
//
// RAG path: the search_document_chunks RPC is keyed by a single deal id,
// so we embed the query ONCE and fan it out across the org's deals (bounded
// to a sane number), then merge + rank by similarity. Naive fallback: a
// substring scan over Document.extractedText joined to the org's deals.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { searchDocumentChunks, isRAGEnabled } from '../../../../rag.js';
import { log } from '../../../../utils/logger.js';

// Bound the fan-out so a large org doesn't trigger dozens of RPC round-trips.
const MAX_DEALS_FANOUT = 30;
const MAX_RESULTS = 10;

export function makeSearchDocumentsTool(orgId: string) {
  return tool(
    async ({ query, dealName }) => {
      try {
        // Resolve the org's deals (optionally narrowed to a named deal).
        let dealQuery = supabase
          .from('Deal')
          .select('id, name')
          .eq('organizationId', orgId)
          .order('updatedAt', { ascending: false })
          .limit(MAX_DEALS_FANOUT);
        if (dealName) dealQuery = dealQuery.ilike('name', `%${dealName}%`);

        const { data: deals, error: dealErr } = await dealQuery;
        if (dealErr) {
          log.error('searchDocuments(org) tool: deal resolve failed', { orgId, error: dealErr });
          return `Error resolving deals: ${dealErr.message}.`;
        }
        if (!deals || deals.length === 0) {
          return dealName
            ? `No deal matching "${dealName}" found in the organization.`
            : 'No deals found in the organization.';
        }
        const dealNameById = new Map(deals.map(d => [d.id, d.name]));
        const dealIds = deals.map(d => d.id);

        if (isRAGEnabled()) {
          // Embed once, fan out across the org's deals, merge by similarity.
          const perDeal = await Promise.all(
            dealIds.map(async (id) => {
              try {
                const hits = await searchDocumentChunks(query, id, 4, 0.4);
                return hits.map(h => ({ ...h, dealId: id }));
              } catch (e) {
                log.debug('searchDocuments(org): per-deal RAG failed', { id, error: e instanceof Error ? e.message : String(e) });
                return [];
              }
            })
          );
          const merged = perDeal.flat()
            .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
            .slice(0, MAX_RESULTS);

          if (merged.length === 0) {
            return `No relevant content found across the firm's documents for "${query}".`;
          }

          // Resolve document names for the matched chunks.
          const docIds = Array.from(new Set(merged.map(m => m.documentId)));
          const { data: docs } = await supabase
            .from('Document')
            .select('id, name, type')
            .in('id', docIds);
          const docById = new Map((docs || []).map(d => [d.id, d]));

          const lines: string[] = [`Found ${merged.length} relevant passage(s) across the firm for "${query}":`, ''];
          for (const m of merged) {
            const doc = docById.get(m.documentId);
            const deal = dealNameById.get(m.dealId) || 'Unknown deal';
            lines.push(`### ${deal} — ${doc?.name || 'Unknown document'} (${doc?.type || 'document'})`);
            lines.push(m.content.trim());
            lines.push('');
          }
          return lines.join('\n').trimEnd();
        }

        // ── Naive fallback (RAG disabled): substring scan over extracted text.
        const { data: documents } = await supabase
          .from('Document')
          .select('id, name, type, extractedText, dealId')
          .in('dealId', dealIds)
          .not('extractedText', 'is', null);

        if (!documents || documents.length === 0) {
          return 'No documents with extracted text found across the firm.';
        }
        const q = query.toLowerCase();
        const relevant = documents.filter(d =>
          d.extractedText?.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)
        ).slice(0, MAX_RESULTS);

        if (relevant.length === 0) return `No relevant content found across the firm's documents for "${query}".`;

        return relevant.map(d => {
          const deal = dealNameById.get(d.dealId) || 'Unknown deal';
          const text = d.extractedText || '';
          const idx = text.toLowerCase().indexOf(q);
          const start = idx >= 0 ? Math.max(0, idx - 200) : 0;
          const end = idx >= 0 ? Math.min(text.length, idx + q.length + 500) : Math.min(text.length, 700);
          return `### ${deal} — ${d.name}\n${text.slice(start, end)}`;
        }).join('\n\n');
      } catch (error) {
        log.error('searchDocuments(org) tool error', error);
        return 'Error searching documents.';
      }
    },
    {
      name: 'search_documents',
      description: 'Search the firm\'s ENTIRE data room — documents across ALL deals (CIMs, teasers, financial reports, memos). Each result is labeled with the deal it belongs to. Use for cross-deal document questions ("which deals mention X", "find the company with Y in their CIM"). Optionally pass dealName to restrict to one deal.',
      schema: z.object({
        query: z.string().describe('What information to find in the firm\'s documents.'),
        dealName: z.string().optional().describe('Optional: restrict the search to a single named deal/company.'),
      }),
    }
  );
}
