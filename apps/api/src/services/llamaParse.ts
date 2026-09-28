/**
 * llamaParse.ts — LlamaParse PDF preprocessing.
 * Extracts clean structured markdown from PDFs, preserving table layouts.
 * Used as Layer 1 before GPT-4o classification for better accuracy.
 *
 * API contract (LlamaParse v1 REST):
 *   POST https://api.cloud.llamaindex.ai/api/v1/parsing/upload  (multipart, field "file")
 *        → { id }
 *   GET  https://api.cloud.llamaindex.ai/api/v1/parsing/job/{id}
 *        → { status: 'PENDING' | 'SUCCESS' | 'ERROR' }
 *   GET  https://api.cloud.llamaindex.ai/api/v1/parsing/job/{id}/result/markdown
 *        → { markdown: string, job_metadata?: { ... }}
 *
 * Earlier revisions of this file omitted the /v1/ prefix and silently 404'd in
 * production — the route fell through to pdf-parse, which on image-heavy
 * one-pagers returns < 200 chars and then bailed before Vision could run.
 * Always log every transition so future failures self-document in Vercel logs.
 */

import { log } from '../utils/logger.js';
import { recordUsageEvent } from './usage/trackedLLM.js';

const apiKey = process.env.LLAMA_CLOUD_API_KEY;
const LLAMA_BASE = 'https://api.cloud.llamaindex.ai/api/v1';

// Per-page price — NOT verified against the team's actual LlamaParse plan
// tier; override via env once confirmed.
const LLAMA_PARSE_PRICE_PER_PAGE_USD = Number(
  process.env.LLAMA_PARSE_PRICE_PER_PAGE_USD ?? 0.003,
);

async function recordLlamaParseUsage(
  status: 'success' | 'error',
  pages: number,
  durationMs: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordUsageEvent({
    operation: 'document_parse',
    provider: 'llamaparse',
    model: 'llamaparse',
    units: pages,
    unitCostUsd: pages * LLAMA_PARSE_PRICE_PER_PAGE_USD,
    status,
    durationMs,
    metadata,
  });
}

if (!apiKey) {
  log.warn('LLAMA_CLOUD_API_KEY not set — LlamaParse disabled, falling back to pdf-parse');
}

export const isLlamaParseEnabled = () => !!apiKey;

/**
 * Parse a PDF buffer using LlamaParse API.
 * Returns clean markdown text with tables preserved, or null on any failure.
 */
export async function parseWithLlama(
  fileBuffer: Buffer,
  fileName: string,
): Promise<{ text: string; pages: number } | null> {
  if (!apiKey) {
    log.warn('LlamaParse: skipped — LLAMA_CLOUD_API_KEY not set');
    return null;
  }

  const sizeKB = Math.round(fileBuffer.length / 1024);
  const start = Date.now();

  try {
    log.info('LlamaParse: starting PDF parse', { fileName, sizeKB });

    // ─── Step 1: Upload the file to start a parse job ─────────
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(fileBuffer)]), fileName);

    const uploadRes = await fetch(`${LLAMA_BASE}/parsing/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '<unreadable>');
      log.error('LlamaParse: upload failed', undefined, {
        status: uploadRes.status,
        statusText: uploadRes.statusText,
        body: errText.slice(0, 500),
        fileName,
        sizeKB,
      });
      await recordLlamaParseUsage('error', 0, Date.now() - start, { stage: 'upload', status: uploadRes.status });
      return null;
    }

    const uploadData = (await uploadRes.json()) as { id?: string };
    const jobId = uploadData.id;

    if (!jobId) {
      log.error('LlamaParse: upload response missing job id', undefined, { uploadData });
      await recordLlamaParseUsage('error', 0, Date.now() - start, { stage: 'upload_missing_job_id' });
      return null;
    }

    log.info('LlamaParse: job created', { jobId, fileName });

    // ─── Step 2: Poll job status (max ~60s @ 2s interval) ──────
    let lastStatus = 'PENDING';
    let succeeded = false;

    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const statusRes = await fetch(`${LLAMA_BASE}/parsing/job/${jobId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
      });

      if (!statusRes.ok) {
        log.warn('LlamaParse: status check failed (will retry)', {
          jobId,
          attempt: i + 1,
          status: statusRes.status,
        });
        continue;
      }

      const statusData = (await statusRes.json()) as { status?: string };
      lastStatus = statusData.status ?? 'UNKNOWN';

      if (lastStatus === 'SUCCESS') {
        succeeded = true;
        break;
      }
      if (lastStatus === 'ERROR' || lastStatus === 'CANCELED') {
        log.error('LlamaParse: job terminal failure', undefined, { jobId, status: lastStatus });
        await recordLlamaParseUsage('error', 0, Date.now() - start, { stage: 'poll', jobStatus: lastStatus });
        return null;
      }
      // Still PENDING — continue polling.
    }

    if (!succeeded) {
      log.warn('LlamaParse: timeout after 60s', { jobId, lastStatus });
      await recordLlamaParseUsage('error', 0, Date.now() - start, { stage: 'poll_timeout', jobStatus: lastStatus });
      return null;
    }

    // ─── Step 3: Retrieve the markdown result ─────────────────
    const markdownRes = await fetch(
      `${LLAMA_BASE}/parsing/job/${jobId}/result/markdown`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
      },
    );

    if (!markdownRes.ok) {
      const errText = await markdownRes.text().catch(() => '<unreadable>');
      log.error('LlamaParse: failed to get markdown', undefined, {
        jobId,
        status: markdownRes.status,
        body: errText.slice(0, 500),
      });
      await recordLlamaParseUsage('error', 0, Date.now() - start, { stage: 'result_fetch', status: markdownRes.status });
      return null;
    }

    const markdownData = (await markdownRes.json()) as {
      markdown?: string;
      job_metadata?: { job_pages?: number };
      pages?: number;
    };

    const text = markdownData.markdown ?? '';
    const pages =
      markdownData.job_metadata?.job_pages ?? markdownData.pages ?? 0;

    if (!text || text.trim().length === 0) {
      log.warn('LlamaParse: returned empty markdown', { jobId, pages });
      await recordLlamaParseUsage('error', pages, Date.now() - start, { stage: 'empty_markdown' });
      return null;
    }

    log.info('LlamaParse: extraction complete', {
      jobId,
      chars: text.length,
      pages,
      fileName,
    });

    await recordLlamaParseUsage('success', pages, Date.now() - start, { fileName });

    return { text, pages };
  } catch (err) {
    log.error('LlamaParse: unexpected error', err, { fileName, sizeKB });
    await recordLlamaParseUsage('error', 0, Date.now() - start, {
      stage: 'unexpected_error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
