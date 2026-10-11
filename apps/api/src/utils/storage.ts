import { supabase } from '../supabase.js';
import { log } from './logger.js';

const SIGNED_URL_EXPIRY = 3600; // 1 hour

/**
 * Extract the storage path from a full Supabase public URL.
 * If the value is already a relative path (no http), returns it as-is.
 */
export function extractStoragePath(fileUrlOrPath: string): string {
  if (!fileUrlOrPath.startsWith('http')) {
    return fileUrlOrPath;
  }
  const match = fileUrlOrPath.match(/\/storage\/v1\/object\/public\/documents\/(.+)/);
  return match ? match[1] : fileUrlOrPath;
}

/**
 * Generate a signed download URL for a document in the private 'documents' bucket.
 * Returns null if generation fails.
 */
export async function getSignedDownloadUrl(
  storagePath: string,
  expiresIn = SIGNED_URL_EXPIRY
): Promise<string | null> {
  const path = extractStoragePath(storagePath);
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(path, expiresIn);

  if (error) {
    log.error('Failed to create signed URL', error, { storagePath: path });
    return null;
  }
  return data.signedUrl;
}

/**
 * Download a file buffer directly from Supabase storage (server-side).
 * Used by backend services that need to process files (e.g., financial extraction).
 */
export async function downloadFileBuffer(storagePath: string): Promise<Buffer | null> {
  const path = extractStoragePath(storagePath);
  const { data, error } = await supabase.storage
    .from('documents')
    .download(path);

  if (error) {
    log.error('Failed to download file from storage', error, { storagePath: path });
    return null;
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Open a document from the private bucket as a streaming HTTP response,
 * server-side. The short-lived signed URL used to fetch it never leaves the
 * server — callers pipe `response.body` to the client, so access can be
 * re-checked on every request (portal downloads after a share is revoked).
 * Returns null if the object can't be fetched.
 */
export async function fetchStorageObject(storagePath: string): Promise<Response | null> {
  const signedUrl = await getSignedDownloadUrl(storagePath, 60);
  if (!signedUrl) return null;
  const response = await fetch(signedUrl);
  if (!response.ok || !response.body) {
    log.error('Failed to fetch file from storage', undefined, {
      storagePath: extractStoragePath(storagePath),
      status: response.status,
    });
    return null;
  }
  return response;
}

/**
 * Get a public URL for assets in public buckets (avatars, org-logos).
 */
export function getPublicAssetUrl(storagePath: string, bucket: string): string | null {
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}
