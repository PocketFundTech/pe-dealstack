import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

export interface WatermarkViewer {
  email: string;
  timestamp?: Date;
  ip?: string | null;
}

const NEUTRAL_GRAY = rgb(0.45, 0.5, 0.55);
const WATERMARK_OPACITY = 0.18;
const WATERMARK_ROTATION = degrees(-30);

function buildLine(viewer: WatermarkViewer): string {
  const ts = (viewer.timestamp ?? new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const ip = viewer.ip ? ` · IP ${viewer.ip}` : '';
  return `${viewer.email} · ${ts} UTC${ip}`;
}

/**
 * Stamp every page of a PDF with a 3-position diagonal watermark identifying
 * the viewer. Original document is not mutated; a new PDF is returned.
 *
 * Throws if the input is not a valid PDF (caller should fall back to passthrough).
 */
export async function watermarkPdf(
  inputBytes: Uint8Array | Buffer,
  viewer: WatermarkViewer,
): Promise<Buffer> {
  // pdf-lib mutates the loaded document, so we can re-serialise the same one.
  // ignoreEncryption: false rejects encrypted PDFs (caller falls back).
  const pdf = await PDFDocument.load(inputBytes, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = buildLine(viewer);

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    // Font size scales to ~1% of page width, clamped sensibly.
    const fontSize = Math.max(7, Math.min(11, Math.round(width * 0.01)));
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    // Three positions: top-left, center, bottom-right. Each rotated -30°.
    const positions: Array<{ x: number; y: number }> = [
      { x: width * 0.1, y: height * 0.85 },
      { x: width / 2 - textWidth / 2, y: height / 2 },
      { x: width * 0.55, y: height * 0.18 },
    ];

    for (const pos of positions) {
      page.drawText(text, {
        x: pos.x,
        y: pos.y,
        size: fontSize,
        font,
        color: NEUTRAL_GRAY,
        opacity: WATERMARK_OPACITY,
        rotate: WATERMARK_ROTATION,
      });
    }
  }

  const outBytes = await pdf.save();
  return Buffer.from(outBytes);
}
