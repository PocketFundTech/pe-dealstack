import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('googleDrive client — native-type helpers', () => {
  it('isGoogleNativeMime distinguishes native Google types from binaries', async () => {
    const { isGoogleNativeMime } = await import('../../../src/integrations/googleDrive/client.js');
    expect(isGoogleNativeMime('application/vnd.google-apps.document')).toBe(true);
    expect(isGoogleNativeMime('application/vnd.google-apps.spreadsheet')).toBe(true);
    expect(isGoogleNativeMime('application/pdf')).toBe(false);
    expect(isGoogleNativeMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
  });

  it('driveExportTargetFor maps Docs→PDF and Sheets→XLSX, null otherwise', async () => {
    const { driveExportTargetFor } = await import('../../../src/integrations/googleDrive/client.js');
    expect(driveExportTargetFor('application/vnd.google-apps.document')).toEqual({
      mimeType: 'application/pdf', ext: 'pdf',
    });
    expect(driveExportTargetFor('application/vnd.google-apps.spreadsheet')).toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx',
    });
    expect(driveExportTargetFor('application/pdf')).toBeNull();
  });
});

describe('googleDrive client — metadata / download / export', () => {
  it('getDriveFileMetadata parses id/name/mimeType and numeric size', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'f1', name: 'CIM.pdf', mimeType: 'application/pdf', size: '2048',
    }), { status: 200 })) as unknown as typeof fetch;
    const { getDriveFileMetadata } = await import('../../../src/integrations/googleDrive/client.js');
    const meta = await getDriveFileMetadata('at', 'f1');
    expect(meta).toEqual({ id: 'f1', name: 'CIM.pdf', mimeType: 'application/pdf', size: 2048 });
    // fields query requests exactly what we need.
    expect(decodeURIComponent((global.fetch as any).mock.calls[0][0])).toMatch(/fields=id,name,mimeType,size/);
  });

  it('getDriveFileMetadata leaves size undefined for native Google files', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'd1', name: 'NDA', mimeType: 'application/vnd.google-apps.document',
    }), { status: 200 })) as unknown as typeof fetch;
    const { getDriveFileMetadata } = await import('../../../src/integrations/googleDrive/client.js');
    const meta = await getDriveFileMetadata('at', 'd1');
    expect(meta.size).toBeUndefined();
  });

  it('downloadDriveFile fetches alt=media and returns a Buffer', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 hello');
    global.fetch = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const { downloadDriveFile } = await import('../../../src/integrations/googleDrive/client.js');
    const buf = await downloadDriveFile('at', 'f1');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toContain('%PDF-1.7');
    expect((global.fetch as any).mock.calls[0][0]).toContain('alt=media');
  });

  it('exportDriveFile hits files/export with the target mimeType', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const { exportDriveFile } = await import('../../../src/integrations/googleDrive/client.js');
    const buf = await exportDriveFile('at', 'd1', 'application/pdf');
    expect(Buffer.isBuffer(buf)).toBe(true);
    const url = decodeURIComponent((global.fetch as any).mock.calls[0][0]);
    expect(url).toMatch(/\/export\?mimeType=application\/pdf/);
  });

  it('maps a 403 insufficient-scope response to INSUFFICIENT_SCOPE', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('insufficient scope', { status: 403 })) as unknown as typeof fetch;
    const { getDriveFileMetadata } = await import('../../../src/integrations/googleDrive/client.js');
    const { GoogleDriveError } = await import('../../../src/integrations/googleDrive/types.js');
    await expect(getDriveFileMetadata('at', 'f1')).rejects.toMatchObject({
      constructor: GoogleDriveError,
      code: 'INSUFFICIENT_SCOPE',
    });
  });
});
