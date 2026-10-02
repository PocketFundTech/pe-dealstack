/**
 * Read a generated .xlsx the way Excel, Quick Look and previews do: from
 * the raw sheet XML, not ExcelJS's `cell.value` getter (which drops a
 * cached result of exactly 0). Shared by the workbook cached-value and
 * parity tests.
 */
import JSZip from 'jszip';

export interface WorkbookXml {
  workbook: string;
  /** Sheet name → raw worksheet XML. */
  sheets: Map<string, string>;
}

export async function readWorkbookXml(buffer: Buffer | Uint8Array): Promise<WorkbookXml> {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const target = new Map(
    [...rels.matchAll(/<Relationship Id="(rId\d+)"[^>]*Target="(worksheets\/sheet\d+\.xml)"/g)].map((m) => [m[1], m[2]]),
  );
  const sheets = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1];
    const rId = m[0].match(/r:id="(rId\d+)"/)?.[1];
    const file = rId && target.get(rId);
    if (name && file) sheets.set(name, await zip.file(`xl/${file}`)!.async('string'));
  }
  return { workbook, sheets };
}

/** The `<v>` text of one cell, or undefined if the cell has no cached result. */
export function cellResult(xml: string, address: string): string | undefined {
  const re = new RegExp(`<c r="${address}"[^>]*>(?:(?!<\\/c>).)*?<v>([^<]*)<\\/v>(?:(?!<\\/c>).)*?<\\/c>`, 's');
  return xml.match(re)?.[1];
}

/** A cell's cached result as a number (NaN when missing or not numeric). */
export function cellNumber(xml: string, address: string): number {
  const raw = cellResult(xml, address);
  return raw === undefined ? NaN : Number(raw);
}

/** Every formula cell in a sheet with no cached `<v>` result. */
export function uncachedFormulaCells(xml: string): string[] {
  const missing: string[] = [];
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:(?!<\/c>).)*?<f[^>]*>.*?<\/f>((?:(?!<\/c>).)*)<\/c>/gs)) {
    if (!/<v>/.test(m[2])) missing.push(m[1]);
  }
  return missing;
}
