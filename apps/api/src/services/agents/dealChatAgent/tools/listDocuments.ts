// ─── list_documents tool ─────────────────────────────────────────
// List all documents uploaded to the deal with file/AI status.
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';

export const inputSchema = z.object({});

export function makeListDocumentsTool(dealId: string, _orgId: string) {
  return {
    type: 'custom' as const,
    name: 'list_documents',
    description: 'List all documents uploaded to this deal with file details and AI analysis status.',
    input_schema: { type: 'object', properties: {} },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async () => {
      try {
        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type, fileSize, createdAt, aiAnalyzedAt, confidence')
          .eq('dealId', dealId)
          .order('createdAt', { ascending: false });

        if (!docs || docs.length === 0) return 'No documents uploaded for this deal.';

        const parts = [`**Documents (${docs.length}):**\n`];
        for (const doc of docs) {
          const size = doc.fileSize ? `${(doc.fileSize / 1024).toFixed(0)} KB` : 'unknown size';
          const date = new Date(doc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const aiStatus = doc.aiAnalyzedAt ? `AI analyzed (${doc.confidence ? Math.round(doc.confidence * 100) + '%' : 'done'})` : 'Not analyzed';
          parts.push(`- **${doc.name}** — ${size}, uploaded ${date}, ${aiStatus}`);
        }
        return parts.join('\n');
      } catch (error) {
        log.error('listDocuments tool error', error);
        return 'Error fetching documents.';
      }
    },
  };
}
