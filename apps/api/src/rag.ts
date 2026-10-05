// ─── RAG Pipeline — LangChain Vector Store ─────────────────────────
// Uses LangChain's embedding abstraction + Supabase vector store.
// Supports Gemini gemini-embedding-001 (primary) with graceful fallback.

import { supabase } from './supabase.js';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { log } from './utils/logger.js';
import { trackedEmbedDocuments, trackedEmbedQuery } from './services/usage/trackedEmbeddings.js';

// ============================================================
// Embeddings via LangChain
// ============================================================

let embeddingsModel: GoogleGenerativeAIEmbeddings | null = null;

/** The real embedding model, env-overridable — single source of truth so the
 *  usage ledger labels rows with what actually ran instead of a hardcoded
 *  guess (see trackedEmbeddings.ts). */
function getEmbeddingModelName(): string {
  return process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
}

function getEmbeddingsModel(): GoogleGenerativeAIEmbeddings | null {
  if (embeddingsModel) return embeddingsModel;
  if (!process.env.GEMINI_API_KEY) {
    log.warn('GEMINI_API_KEY not set, RAG embeddings disabled');
    return null;
  }
  embeddingsModel = new GoogleGenerativeAIEmbeddings({
    modelName: getEmbeddingModelName(),
    apiKey: process.env.GEMINI_API_KEY,
  });
  return embeddingsModel;
}

export function isRAGEnabled(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// ============================================================
// Text Chunking
// ============================================================

interface Chunk {
  content: string;
  index: number;
  tokenCount: number;
}

/**
 * Split text into chunks for embedding
 * Uses sentence-aware chunking to avoid breaking mid-sentence
 */
export function chunkText(text: string, maxTokens: number = 500, overlap: number = 50): Chunk[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const estimateTokens = (s: string) => Math.ceil(s.length / 4);
  const sentences = text.split(/(?<=[.!?])\s+/);

  const chunks: Chunk[] = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    const testChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;

    if (estimateTokens(testChunk) > maxTokens && currentChunk) {
      chunks.push({
        content: currentChunk.trim(),
        index: chunkIndex++,
        tokenCount: estimateTokens(currentChunk),
      });

      const overlapText = getOverlapText(currentChunk, overlap);
      currentChunk = overlapText + ' ' + sentence;
    } else {
      currentChunk = testChunk;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      index: chunkIndex,
      tokenCount: estimateTokens(currentChunk),
    });
  }

  return chunks;
}

function getOverlapText(text: string, targetTokens: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let overlap = '';

  for (let i = sentences.length - 1; i >= 0; i--) {
    const test = sentences[i] + (overlap ? ' ' + overlap : '');
    if (Math.ceil(test.length / 4) > targetTokens) break;
    overlap = test;
  }

  return overlap;
}

// ============================================================
// Document Embedding (LangChain embeddings)
// ============================================================

/**
 * Embed a document's text and store chunks in the database
 */
export async function embedDocument(
  documentId: string,
  dealId: string,
  text: string
): Promise<{ success: boolean; chunkCount: number; error?: string }> {
  const model = getEmbeddingsModel();
  if (!model) {
    return { success: false, chunkCount: 0, error: 'Embeddings model not available' };
  }

  try {
    await supabase
      .from('Document')
      .update({ embeddingStatus: 'processing' })
      .eq('id', documentId);

    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await supabase
        .from('Document')
        .update({
          embeddingStatus: 'completed',
          chunkCount: 0,
          embeddedAt: new Date().toISOString()
        })
        .eq('id', documentId);
      return { success: true, chunkCount: 0 };
    }

    // Use LangChain embeddings (batch). Wrapped to record one UsageEvent
    // per ingest with units = chunk count and char-based cost.
    const chunkTexts = chunks.map(c => c.content);
    const embeddings = await trackedEmbedDocuments(
      'gemini_embed_doc',
      chunkTexts,
      () => model.embedDocuments(chunkTexts),
      getEmbeddingModelName(),
    );

    // Delete existing chunks for this document
    await supabase
      .from('DocumentChunk')
      .delete()
      .eq('documentId', documentId);

    // Insert new chunks with embeddings
    const chunkRecords = chunks.map((chunk, i) => ({
      documentId,
      dealId,
      chunkIndex: chunk.index,
      content: chunk.content,
      embedding: embeddings[i] ? `[${embeddings[i].join(',')}]` : null,
      tokenCount: chunk.tokenCount,
      metadata: {},
    }));

    const batchSize = 50;
    for (let i = 0; i < chunkRecords.length; i += batchSize) {
      const batch = chunkRecords.slice(i, i + batchSize);
      const { error } = await supabase
        .from('DocumentChunk')
        .insert(batch);

      if (error) {
        log.error('Error inserting chunks', error);
        throw error;
      }
    }

    await supabase
      .from('Document')
      .update({
        embeddingStatus: 'completed',
        chunkCount: chunks.length,
        embeddedAt: new Date().toISOString()
      })
      .eq('id', documentId);

    log.debug('Document embedded (LangChain)', { documentId, chunkCount: chunks.length });
    return { success: true, chunkCount: chunks.length };

  } catch (error: any) {
    log.error('Error embedding document', error);

    await supabase
      .from('Document')
      .update({ embeddingStatus: 'failed' })
      .eq('id', documentId);

    return { success: false, chunkCount: 0, error: error.message };
  }
}

// ============================================================
// Semantic Search (LangChain embeddings + Supabase RPC)
// ============================================================

interface SearchResult {
  id: string;
  documentId: string;
  dealId: string;
  content: string;
  similarity: number;
  metadata: any;
}

/**
 * Search for relevant document chunks using vector similarity
 */
export async function searchDocumentChunks(
  query: string,
  dealId: string,
  limit: number = 10,
  threshold: number = 0.5
): Promise<SearchResult[]> {
  const model = getEmbeddingsModel();
  if (!model) {
    log.warn('Embeddings not available, cannot perform semantic search');
    return [];
  }

  try {
    const queryEmbedding = await trackedEmbedQuery(
      'gemini_embed_query',
      query,
      () => model.embedQuery(query),
      getEmbeddingModelName(),
    );
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const { data, error } = await supabase.rpc('search_document_chunks', {
      query_embedding: embeddingStr,
      match_threshold: threshold,
      match_count: limit,
      filter_deal_id: dealId,
    });

    if (error) {
      log.error('Error searching chunks', error);
      return [];
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      documentId: row.documentId,
      dealId: row.dealId,
      content: row.content,
      similarity: row.similarity,
      metadata: row.metadata,
    }));

  } catch (error) {
    log.error('Error in semantic search', error);
    return [];
  }
}

/**
 * Build context from search results for RAG
 */
export function buildRAGContext(
  searchResults: SearchResult[],
  documents: Array<{ id: string; name: string; type: string }>
): string {
  if (searchResults.length === 0) {
    return 'No relevant document content found.';
  }

  const byDocument = new Map<string, SearchResult[]>();
  for (const result of searchResults) {
    const existing = byDocument.get(result.documentId) || [];
    existing.push(result);
    byDocument.set(result.documentId, existing);
  }

  const contextParts: string[] = [];

  for (const [docId, results] of byDocument) {
    const doc = documents.find(d => d.id === docId);
    const docName = doc?.name || 'Unknown Document';
    const docType = doc?.type || 'document';

    contextParts.push(`\n### From: ${docName} (${docType})`);
    results.sort((a, b) => (a.metadata?.chunkIndex || 0) - (b.metadata?.chunkIndex || 0));

    for (const result of results) {
      contextParts.push(result.content);
    }
  }

  return contextParts.join('\n\n');
}

// ============================================================
// Utility: Embed all pending documents for a deal
// ============================================================

export async function embedPendingDocuments(dealId: string): Promise<number> {
  const { data: documents, error } = await supabase
    .from('Document')
    .select('id, extractedText')
    .eq('dealId', dealId)
    .eq('embeddingStatus', 'pending')
    .not('extractedText', 'is', null);

  if (error || !documents) {
    log.error('Error fetching pending documents', error);
    return 0;
  }

  let embedded = 0;
  for (const doc of documents) {
    if (doc.extractedText) {
      const result = await embedDocument(doc.id, dealId, doc.extractedText);
      if (result.success) embedded++;
    }
  }

  return embedded;
}
