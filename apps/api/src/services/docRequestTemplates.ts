// ─── Document-request checklist templates ─────────────────────────
// Static packages a user picks from when asking a broker or seller for
// documents. Deliberately code, not DB: these are product defaults, not
// tenant data, so they need no migration and no per-org seeding. Users
// edit the expanded list before sending, and anything bespoke arrives as
// an explicit `items[]` on the create request instead.
//
// `docType` maps onto the Document.type enum in routes/documents-upload.ts
// so an uploaded file lands with the right type (and therefore the right
// VDR folder + extraction path). Leave it undefined when no enum member
// fits — 'OTHER' is inferred downstream.

export interface DocRequestTemplateItem {
  label: string;
  docType?: string;
  notes?: string;
  required: boolean;
}

export interface DocRequestChecklistItem extends DocRequestTemplateItem {
  sortOrder: number;
}

export const DOC_REQUEST_TEMPLATES = {
  STANDARD_DD: [
    { label: '3-year P&L', docType: 'FINANCIALS', required: true },
    { label: 'Balance sheet (latest + 2 prior year-ends)', docType: 'FINANCIALS', required: true },
    { label: 'Cash flow statement', docType: 'FINANCIALS', required: true },
    { label: 'Trailing-12 monthly P&L', docType: 'FINANCIALS', required: true },
    { label: 'Add-back / normalization schedule', docType: 'FINANCIALS', required: true,
      notes: 'Owner comp, one-time items, and any other EBITDA adjustments.' },
    { label: 'Customer concentration (top 10 by revenue)', docType: 'FINANCIALS', required: true },
    { label: 'Revenue by product or service line', docType: 'FINANCIALS', required: false },
    { label: 'Headcount roster by function', required: false,
      notes: 'Titles and tenure are enough — no names or personal data needed.' },
    { label: 'AR / AP aging', docType: 'FINANCIALS', required: false },
    { label: 'Tax returns (3 years)', docType: 'FINANCIALS', required: false },
    { label: 'Equipment / fixed asset list', required: false },
    { label: 'Lease agreements', docType: 'LEGAL', required: false },
    { label: 'Owner compensation detail', docType: 'FINANCIALS', required: false },
  ],

  FINANCIALS_ONLY: [
    { label: '3-year P&L', docType: 'FINANCIALS', required: true },
    { label: 'Balance sheet (latest + 2 prior year-ends)', docType: 'FINANCIALS', required: true },
    { label: 'Cash flow statement', docType: 'FINANCIALS', required: true },
    { label: 'Trailing-12 monthly P&L', docType: 'FINANCIALS', required: true },
    { label: 'Add-back / normalization schedule', docType: 'FINANCIALS', required: true },
    { label: 'Customer concentration (top 10 by revenue)', docType: 'FINANCIALS', required: false },
  ],

  QOE_PREP: [
    { label: 'Bank statements (12 months)', docType: 'FINANCIALS', required: true },
    { label: 'Payment-processor settlement reports', docType: 'FINANCIALS', required: true },
    { label: 'Revenue recognition policy', required: true },
    { label: 'Deferred-revenue schedule', docType: 'FINANCIALS', required: false },
    { label: 'Inventory detail', docType: 'FINANCIALS', required: false },
    { label: 'Related-party transactions', docType: 'FINANCIALS', required: false },
  ],

  LEGAL_CORPORATE: [
    { label: 'Cap table', docType: 'LEGAL', required: true },
    { label: 'Org chart / entity structure', docType: 'LEGAL', required: true },
    { label: 'Material contracts', docType: 'LEGAL', required: true },
    { label: 'Litigation history', docType: 'LEGAL', required: false },
    { label: 'Insurance certificates', docType: 'LEGAL', required: false },
    { label: 'Key licences and permits', docType: 'LEGAL', required: false },
  ],
} satisfies Record<string, DocRequestTemplateItem[]>;

export type DocRequestTemplateKey = keyof typeof DOC_REQUEST_TEMPLATES;

export const DOC_REQUEST_TEMPLATE_KEYS = Object.keys(
  DOC_REQUEST_TEMPLATES,
) as DocRequestTemplateKey[];

export function isTemplateKey(value: string): value is DocRequestTemplateKey {
  return Object.prototype.hasOwnProperty.call(DOC_REQUEST_TEMPLATES, value);
}

/**
 * Expand a template into a numbered checklist. Returns freshly-copied items
 * so callers can edit the list (rename, drop, reorder) without mutating the
 * shared constant.
 */
export function expandTemplate(key: DocRequestTemplateKey): DocRequestChecklistItem[] {
  return DOC_REQUEST_TEMPLATES[key].map((item, index) => ({
    ...item,
    sortOrder: index,
  }));
}
