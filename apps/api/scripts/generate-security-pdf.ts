// Renders security-pdf.html to a 2-page Letter PDF.
// Run with: npx tsx apps/api/scripts/generate-security-pdf.ts

import { fileURLToPath } from 'url';
import path from 'path';
import { writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const puppeteer = await import('puppeteer');

  const htmlPath = path.resolve(__dirname, '../../../apps/web/security-pdf.html');
  const outPath = path.resolve(__dirname, '../../../apps/web/assets/pocket-fund-security-overview.pdf');

  const browser = await puppeteer.default.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' },
  });
  await browser.close();
  await writeFile(outPath, pdf);
  console.log(`Wrote ${outPath} (${pdf.byteLength} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
