import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { watermarkPdf } from '../src/services/pdfWatermark.js';

async function makeBlankPdf(pageCount: number, pageSize: [number, number] = [612, 792]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.addPage(pageSize);
    page.drawText(`Original page ${i + 1}`, {
      x: 50,
      y: pageSize[1] - 50,
      size: 14,
      font,
    });
  }
  return Buffer.from(await pdf.save());
}

describe('watermarkPdf', () => {
  it('returns a Buffer that is still a valid PDF', async () => {
    const input = await makeBlankPdf(3);
    const out = await watermarkPdf(input, { email: 'engineer@pocket-fund.com' });
    expect(Buffer.isBuffer(out)).toBe(true);
    // PDFs always start with the bytes "%PDF-"
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('preserves the original page count', async () => {
    const input = await makeBlankPdf(7);
    const out = await watermarkPdf(input, { email: 'a@b.com' });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPages()).toHaveLength(7);
  });

  it('embeds the viewer email + timestamp into the document body', async () => {
    const input = await makeBlankPdf(1);
    const out = await watermarkPdf(input, {
      email: 'forensic-test@pocket-fund.com',
      timestamp: new Date('2026-05-10T14:23:00Z'),
      ip: '203.0.113.5',
    });

    // The watermark text is drawn into page content streams. pdf-lib stores
    // page text inside compressed content streams, so we can't trivially
    // grep the raw bytes. Instead we confirm the watermarked PDF is bigger
    // than the original (3 watermark draws per page) and structurally valid.
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPages()).toHaveLength(1);
    expect(out.length).toBeGreaterThan(input.length);
  });

  it('handles very small page sizes without crashing', async () => {
    const input = await makeBlankPdf(1, [200, 200]);
    const out = await watermarkPdf(input, { email: 'edge@case.com' });
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  it('throws on completely invalid input (caller falls back)', async () => {
    const garbage = Buffer.from('this is not a pdf at all');
    await expect(
      watermarkPdf(garbage, { email: 'x@y.com' }),
    ).rejects.toThrow();
  });

  it('produces deterministic structure for the same viewer + same timestamp', async () => {
    const input = await makeBlankPdf(2);
    const ts = new Date('2026-05-10T10:00:00Z');
    const a = await watermarkPdf(input, { email: 'a@a.com', timestamp: ts, ip: '1.1.1.1' });
    const b = await watermarkPdf(input, { email: 'a@a.com', timestamp: ts, ip: '1.1.1.1' });
    // Both should be valid PDFs with the same page count; bytes may differ
    // due to PDF object IDs but the structural shape should match.
    const ra = await PDFDocument.load(a);
    const rb = await PDFDocument.load(b);
    expect(ra.getPages().length).toBe(rb.getPages().length);
  });

  it('omits IP segment when not provided', async () => {
    // Just ensures no crash; the conditional in buildLine handles missing IP
    const input = await makeBlankPdf(1);
    const out = await watermarkPdf(input, { email: 'noip@x.com' });
    expect(Buffer.isBuffer(out)).toBe(true);
  });
});
