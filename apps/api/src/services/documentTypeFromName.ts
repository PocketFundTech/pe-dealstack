/**
 * Guess a document type from its filename (and mime type).
 *
 * Used by both upload paths (documents-upload.ts and ingest-upload.ts) so the
 * rules cannot drift. Short abbreviations (NDA / LOI / DD) are matched on word
 * boundaries: bare substring checks classified "Standard CSP Master Customer
 * Services Agreement" as an NDA ("sta-nda-rd"), "Process Letter" as an LOI,
 * and anything containing "add" as due diligence ("Addendum").
 */

export type DocumentTypeProfile = 'upload' | 'ingest';

const NDA_RE = /\bnda\b|non[- ]?disclosure/;
const LOI_RE = /\bloi\b|letter of intent/;
const DD_RE = /\bdd\b|due diligence/;

// \b treats "_" as a word character, so "Mutual_NDA.pdf" would not match.
// Normalise separators to spaces first.
function normalise(name: string): string {
  return name.toLowerCase().replace(/[_.\-]+/g, (m) => (m === '-' ? '-' : ' '));
}

export function documentTypeFromName(
  documentName: string,
  mimeType?: string | null,
  profile: DocumentTypeProfile = 'upload',
): string {
  const lowerName = documentName.toLowerCase();
  const words = normalise(documentName);
  const lowerMime = (mimeType ?? '').toLowerCase();
  const looksLikeSpreadsheet =
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xls') ||
    lowerName.endsWith('.csv') ||
    lowerMime.includes('spreadsheet') ||
    lowerMime.includes('excel') ||
    lowerMime === 'text/csv' ||
    lowerMime === 'application/csv';

  if (lowerName.includes('cim') || lowerName.includes('confidential')) return 'CIM';
  if (lowerName.includes('teaser')) return 'TEASER';
  if (
    lowerName.includes('financial') ||
    lowerName.includes('model') ||
    lowerName.includes('p&l') ||
    lowerName.includes('p_l') ||
    lowerName.includes('income') ||
    lowerName.includes('balance') ||
    lowerName.includes('cashflow') ||
    lowerName.includes('cash flow') ||
    lowerName.includes('master sheet') ||
    lowerName.includes('mastersheet') ||
    looksLikeSpreadsheet
  ) return 'FINANCIALS';

  if (profile === 'ingest') {
    if (LOI_RE.test(words)) return 'LOI';
    if (DD_RE.test(words)) return 'DD_REPORT';
    return 'OTHER';
  }

  if (lowerName.includes('legal') || DD_RE.test(words)) return 'LEGAL';
  if (NDA_RE.test(words)) return 'NDA';
  if (LOI_RE.test(words)) return 'LOI';
  if (lowerName.includes('email') || lowerName.endsWith('.msg')) return 'EMAIL';
  return 'OTHER';
}
