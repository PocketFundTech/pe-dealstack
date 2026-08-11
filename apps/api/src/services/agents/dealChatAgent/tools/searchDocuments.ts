// ─── search_documents tool ────────────────────────────────────────
// RAG-backed semantic search over deal documents (with naive fallback
// when RAG is disabled).
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { searchDocumentChunks, buildRAGContext, isRAGEnabled } from '../../../../rag.js';
import { log } from '../../../../utils/logger.js';
import { wrapDocumentContent } from '../../guardrails.js';

export const inputSchema = z.object({
  query: z.string().describe('The search query — what information to find in the documents'),
});

export function makeSearchDocumentsTool(dealId: string, _orgId: string) {
  return {
    type: 'custom' as const,
    name: 'search_documents',
    description: 'Search through all uploaded deal documents using semantic search. Use this when the user asks about specific information from documents, CIMs, financial reports, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query — what information to find in the documents' },
      },
      required: ['query'],
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ query }: z.infer<typeof inputSchema>) => {
      try {
        if (!isRAGEnabled()) {
          const { data: docs } = await supabase
            .from('Document')
            .select('id, name, type, extractedText')
            .eq('dealId', dealId)
            .not('extractedText', 'is', null);

          if (!docs || docs.length === 0) return 'No documents found for this deal.';

          const queryLower = query.toLowerCase();
          const relevant = docs.filter(d =>
            d.extractedText?.toLowerCase().includes(queryLower) ||
            d.name.toLowerCase().includes(queryLower)
          );

          if (relevant.length === 0) return 'No relevant content found in documents.';

          // Wrap each excerpt in <document> delimiters so the agent
          // treats it as untrusted external data, not instructions (Task 4.7).
          return relevant.map(d => {
            const text = d.extractedText || '';
            const idx = text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 200);
            const end = Math.min(text.length, idx + queryLower.length + 500);
            return wrapDocumentContent(text.slice(start, end), d.name);
          }).join('\n\n');
        }

        const searchResults = await searchDocumentChunks(query, dealId, 8, 0.4);
        if (searchResults.length === 0) return 'No relevant content found in documents.';

        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type')
          .eq('dealId', dealId);

        // RAG context concatenates retrieved chunks of user-uploaded
        // document text — wrap the entire block so the agent treats it
        // as untrusted external data (Task 4.7).
        return wrapDocumentContent(buildRAGContext(searchResults, docs || []), 'rag-results');
      } catch (error) {
        log.error('searchDocuments tool error', error);
        return 'Error searching documents.';
      }
    },
  };
}
