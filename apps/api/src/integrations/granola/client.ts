import { log } from '../../utils/logger.js';
import type {
  GranolaNoteListResponse,
  GranolaNoteSummary,
  GranolaNoteWithTranscript,
  GranolaUserInfo,
} from './types.js';

function getBaseUrl(): string {
  return process.env.GRANOLA_API_BASE ?? 'https://public-api.granola.ai';
}

interface FetchOptions {
  retries?: number;
}

async function granolaFetch(
  apiKey: string,
  path: string,
  options: FetchOptions = {}
): Promise<Response> {
  const retries = options.retries ?? 1;
  const url = `${getBaseUrl()}${path}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
        const waitMs = Math.max(0, retryAfter * 1000);
        log.warn('granola: rate limited, retrying', { path, waitMs });
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
    }
  }
  throw lastError ?? new Error('granolaFetch: unknown error');
}

export async function validateKey(apiKey: string): Promise<GranolaUserInfo> {
  const res = await granolaFetch(apiKey, '/v1/me');
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 403) {
    throw new Error('Plan not supported — Granola API requires Business or Enterprise');
  }
  if (!res.ok) {
    throw new Error(`Granola validateKey failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GranolaUserInfo;
}

export async function listNotesSince(
  apiKey: string,
  sinceIso: string
): Promise<GranolaNoteSummary[]> {
  const out: GranolaNoteSummary[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const MAX_PAGES = 50;
  do {
    const params = new URLSearchParams({ created_after: sinceIso });
    if (cursor) params.set('cursor', cursor);
    const res = await granolaFetch(apiKey, `/v1/notes?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Granola listNotes failed: ${res.status} ${await res.text()}`);
    }
    const page = (await res.json()) as GranolaNoteListResponse;
    out.push(...page.data);
    cursor = page.hasMore ? page.nextCursor : null;
    pageCount++;
    if (pageCount >= MAX_PAGES) {
      log.warn('granola: listNotesSince hit MAX_PAGES, stopping early', { pageCount });
      break;
    }
  } while (cursor);
  return out;
}

export async function getNoteWithTranscript(
  apiKey: string,
  noteId: string
): Promise<GranolaNoteWithTranscript> {
  const res = await granolaFetch(
    apiKey,
    `/v1/notes/${encodeURIComponent(noteId)}?include=transcript`
  );
  if (!res.ok) {
    throw new Error(`Granola getNote failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GranolaNoteWithTranscript;
}
