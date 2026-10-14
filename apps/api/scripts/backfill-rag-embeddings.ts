/**
 * Re-embed every Document's extractedText into DocumentChunk.
 *
 * Since 2026-05-04 (945bf458) rag.ts called gemini-embedding-001 without
 * outputDimensionality, so it got 3072-dim vectors that the vector(768)
 * column rejected: every upload since then is embeddingStatus='failed' and
 * has no chunks. Chunks written before that date came from text-embedding-004
 * — a different vector space — so they can't be compared against
 * gemini-embedding-001 queries either. Both groups need re-embedding; the
 * default run does all documents.
 *
 * Idempotent — embedDocument() deletes a document's chunks before inserting
 * new ones, so re-running yields the same end state.
 *
 * Usage:
 *   # Preview which documents would be re-embedded. Recommended first.
 *   npx tsx scripts/backfill-rag-embeddings.ts --dry-run
 *
 *   npx tsx scripts/backfill-rag-embeddings.ts
 *
 *   # Optional: only documents whose last embed attempt failed.
 *   npx tsx scripts/backfill-rag-embeddings.ts --only-failed
 *
 *   # Optional: limit to one deal (for a smoke test before the full run).
 *   npx tsx scripts/backfill-rag-embeddings.ts --deal=<dealId>
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY from .env
 * (mirrors the live API process). Bypasses RLS via the service role key.
 */

import { supabase } from '../src/supabase.js';
import { embedDocument, isRAGEnabled } from '../src/rag.js';

interface DocumentRow {
  id: string;
  dealId: string;
  name: string | null;
  embeddingStatus: string | null;
}

const PAGE_SIZE = 500;

function parseArgs(argv: string[]): { dryRun: boolean; onlyFailed: boolean; dealId: string | null } {
  let dryRun = false;
  let onlyFailed = false;
  let dealId: string | null = null;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--only-failed') onlyFailed = true;
    else if (arg.startsWith('--deal=')) dealId = arg.slice('--deal='.length);
  }
  return { dryRun, onlyFailed, dealId };
}

/** Snapshot the work list up front (without extractedText, which can be
 *  large) so re-embedding doesn't shift the pages underneath us. */
async function listDocuments(onlyFailed: boolean, dealId: string | null): Promise<DocumentRow[]> {
  const rows: DocumentRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('Document')
      .select('id, dealId, name, embeddingStatus')
      .not('extractedText', 'is', null)
      .not('dealId', 'is', null)
      .order('createdAt', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (onlyFailed) query = query.eq('embeddingStatus', 'failed');
    if (dealId) query = query.eq('dealId', dealId);

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as DocumentRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchText(id: string): Promise<string | null> {
  const { data, error } = await supabase.from('Document').select('extractedText').eq('id', id).single();
  if (error) throw error;
  return data?.extractedText ?? null;
}

async function main(): Promise<void> {
  const { dryRun, onlyFailed, dealId } = parseArgs(process.argv.slice(2));
  if (!isRAGEnabled()) {
    console.error('GEMINI_API_KEY not set — nothing to do.');
    process.exit(1);
  }

  console.log(`Re-embedding documents${onlyFailed ? ' (failed only)' : ''}${dealId ? ` for deal ${dealId}` : ''}${dryRun ? ' [dry run]' : ''}`);

  const docs = await listDocuments(onlyFailed, dealId);
  console.log(`${docs.length} documents with extracted text.`);

  let ok = 0;
  let failed = 0;
  let totalChunks = 0;
  const failures: string[] = [];

  for (const doc of docs) {
    const label = `${doc.id} (${doc.name ?? 'unnamed'}, was ${doc.embeddingStatus ?? 'null'})`;
    if (dryRun) {
      console.log(`  would embed ${label}`);
      continue;
    }
    const text = await fetchText(doc.id);
    const result = text
      ? await embedDocument(doc.id, doc.dealId, text)
      : { success: false, chunkCount: 0, error: 'extractedText disappeared' };
    if (result.success) {
      ok++;
      totalChunks += result.chunkCount;
      console.log(`  ✓ ${label} → ${result.chunkCount} chunks`);
    } else {
      failed++;
      failures.push(`${label}: ${result.error}`);
      console.log(`  ✗ ${label}: ${result.error}`);
    }
  }

  console.log(`\nDone. ${docs.length} documents seen, ${ok} embedded (${totalChunks} chunks), ${failed} failed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
