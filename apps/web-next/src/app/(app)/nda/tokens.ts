// Client-side token substitution for the NDA preview pane.
//
// Mirrors `apps/api/src/services/legalDocSubstituteService.ts` but with
// muted-italic placeholders ("__counterparty name__" etc.) for empty
// values, so the preview makes it obvious which fields still need filling.
// The backend's final substitution at /send replaces these with the real
// values; the client-side helper here is preview-only and never persisted.
//
// No regex, no fuzzy matching — String.replaceAll on the literal `[TOKEN]`
// marker, same contract as the backend.

import { SIGNATURE_BLOCK_MARKER } from "./constants";

// Same key set as the backend's LEGAL_DOC_TOKEN_KEYS — keep these in sync.
const TOKEN_KEYS = [
  "COUNTERPARTY_NAME",
  "COUNTERPARTY_ADDRESS",
  "COUNTERPARTY_EMAIL",
  "EFFECTIVE_DATE",
  "JURISDICTION",
  "DEAL_NAME",
  "FIRM_NAME",
  "TODAY",
] as const;

type TokenKey = (typeof TOKEN_KEYS)[number];

// Human-readable fallback labels rendered in muted italics so the user
// can see which token is unfilled at a glance.
const PLACEHOLDER_LABELS: Record<TokenKey, string> = {
  COUNTERPARTY_NAME: "counterparty name",
  COUNTERPARTY_ADDRESS: "counterparty address",
  COUNTERPARTY_EMAIL: "counterparty email",
  EFFECTIVE_DATE: "effective date",
  JURISDICTION: "jurisdiction",
  DEAL_NAME: "deal name",
  FIRM_NAME: "firm name",
  TODAY: "today",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Format a YYYY-MM-DD string as "Month DD, YYYY". Falls back to the raw
// input on parse failure — same behaviour as the backend.
export function formatLongDate(input: string | undefined | null): string {
  if (!input) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!m) return input;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!month || month < 1 || month > 12) return input;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// Renders an unfilled token as a muted-italic placeholder. Inline span so
// it survives Editor's DOMPurify allowlist + the .legal-editor scoped CSS.
function placeholder(key: TokenKey): string {
  const label = PLACEHOLDER_LABELS[key];
  return `<span style="color:#94a3b8;font-style:italic;">__${label}__</span>`;
}

// Raw values the preview pulls from the form + the parent doc + the user.
// Trimming + the deal-name fallback (target → projectName) happen here so
// callers can pass form state directly. Pass null/undefined for any
// unfilled field — the helper paints the muted placeholder for those.
export interface TokenSubstitutionValues {
  counterpartyName?: string | null;
  counterpartyAddress?: string | null;
  counterpartyEmail?: string | null;
  effectiveDate?: string | null;
  jurisdiction?: string | null;
  dealName?: string | null;
  firmName?: string | null;
}

/**
 * Substitute `[TOKEN]` markers in `bodyHtml` with values from the deal's
 * counterparty metadata + the current user's firm + today's date.
 *
 * Empty / null values become muted-italic placeholder spans so the user
 * can see at-a-glance which fields are still unfilled. Effective date is
 * reformatted to "Month DD, YYYY" to match the backend's send-time output.
 *
 * Preview-only — does NOT call the backend. The backend has its own
 * substitution at /send time which is the source of truth for the actual
 * outbound document.
 */
export function substituteTokens(
  bodyHtml: string,
  values: TokenSubstitutionValues,
): string {
  const todayIso = new Date().toISOString().slice(0, 10);
  const resolved: Record<TokenKey, string> = {
    COUNTERPARTY_NAME: values.counterpartyName?.trim() || "",
    COUNTERPARTY_ADDRESS: values.counterpartyAddress?.trim() || "",
    COUNTERPARTY_EMAIL: values.counterpartyEmail?.trim() || "",
    EFFECTIVE_DATE: formatLongDate(values.effectiveDate),
    JURISDICTION: values.jurisdiction?.trim() || "",
    DEAL_NAME: values.dealName?.trim() || "",
    FIRM_NAME: values.firmName?.trim() || "",
    TODAY: formatLongDate(todayIso),
  };

  let out = bodyHtml;
  for (const key of TOKEN_KEYS) {
    const value = resolved[key] || placeholder(key);
    out = out.replaceAll(`[${key}]`, value);
  }
  return out;
}

// Standalone-paragraph form of the signature marker — see the backend's
// MARKER_PARAGRAPH_RE. Keep the escaped marker text in sync with
// SIGNATURE_BLOCK_MARKER.
const SIGNATURE_PARAGRAPH_RE =
  /<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*\[SIGNATURE_BLOCK\](?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi;

// Preview chrome for the dropped signature field — a dashed box so the user
// can see WHERE the signature lands. This is preview-only; the real output is
// hidden Dropbox text tags (eSign) or an underscored line (email).
function signaturePreviewHtml(): string {
  return [
    '<div style="margin-top:32px;padding:14px 16px;border:1px dashed #94a3b8;border-radius:6px;background:#f8fafc;">',
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:10px;">Signature field</div>',
    '<p style="margin:0 0 2px;font-weight:bold;">Signature</p>',
    '<p style="margin:0 0 18px;color:#94a3b8;">______________________________</p>',
    '<p style="margin:0 0 2px;font-weight:bold;">Date</p>',
    '<p style="margin:0;color:#94a3b8;">__________________</p>',
    "</div>",
  ].join("");
}

/**
 * Replace `[SIGNATURE_BLOCK]` markers with a visible preview placeholder so the
 * preview pane doesn't show the raw marker text. Mirrors the backend's
 * placeBlock: swap the whole standalone <p>, then any leftover inline marker.
 * Preview-only — the backend does the real substitution at send time.
 */
export function renderSignaturePlaceholder(bodyHtml: string): string {
  if (!bodyHtml.includes(SIGNATURE_BLOCK_MARKER)) return bodyHtml;
  return bodyHtml
    .replace(SIGNATURE_PARAGRAPH_RE, signaturePreviewHtml())
    .split(SIGNATURE_BLOCK_MARKER)
    .join(signaturePreviewHtml());
}
