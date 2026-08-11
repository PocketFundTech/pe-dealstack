import type { DocStatus, DocType, TokenKey } from "./types";

// Human labels for the doc-type enum. Used in dropdowns + the status pill
// subtitle when we eventually expand to LOI / Term Sheet / etc.
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  NDA: "NDA",
  LOI: "Letter of Intent",
  TERM_SHEET: "Term Sheet",
  DEFINITIVE_AGREEMENT: "Definitive Agreement",
  SIDE_LETTER: "Side Letter",
  OTHER: "Other",
};

export const STATUS_LABELS: Record<DocStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  SIGNED: "Signed",
  EXPIRED: "Expired",
};

// Tailwind class trio (bg / text / border) per status. Mirrors the legacy
// stage-pill colour map so a banker glancing at the gallery picks up status
// at a glance: slate = pre-send, amber = waiting, emerald = closed, rose =
// no longer valid.
export const STATUS_COLOR_CLASSES: Record<
  DocStatus,
  { bg: string; text: string; border: string }
> = {
  DRAFT: { bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-200" },
  SENT: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
  SIGNED: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
  EXPIRED: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" },
};

// All four statuses in render order — used by the edit-side status dropdown
// so the progression reads left-to-right, draft -> signed -> expired.
export const STATUS_ORDER: DocStatus[] = ["DRAFT", "SENT", "SIGNED", "EXPIRED"];

// Tokens the user can drop into a template. Backend substitutes these on
// send. Order in TOKEN_KEYS = order they appear in the palette UI.
export const TOKEN_KEYS: TokenKey[] = [
  "COUNTERPARTY_NAME",
  "COUNTERPARTY_ADDRESS",
  "COUNTERPARTY_EMAIL",
  "EFFECTIVE_DATE",
  "JURISDICTION",
  "DEAL_NAME",
  "FIRM_NAME",
  "TODAY",
];

export const TOKEN_LABELS: Record<TokenKey, string> = {
  COUNTERPARTY_NAME: "Counterparty name",
  COUNTERPARTY_ADDRESS: "Counterparty address",
  COUNTERPARTY_EMAIL: "Counterparty email",
  EFFECTIVE_DATE: "Effective date",
  JURISDICTION: "Jurisdiction",
  DEAL_NAME: "Deal name",
  FIRM_NAME: "Firm name",
  TODAY: "Today's date",
};

// Single-line hover descriptions shown when the user mouses over a token pill
// in the palette. Kept literal so reviewers can scan what each one does.
export const TOKEN_DESCRIPTIONS: Record<TokenKey, string> = {
  COUNTERPARTY_NAME:
    "Replaced with the counterparty's legal name when an NDA is created.",
  COUNTERPARTY_ADDRESS:
    "Replaced with the counterparty's mailing address from the create form.",
  COUNTERPARTY_EMAIL:
    "Replaced with the counterparty's notice email from the create form.",
  EFFECTIVE_DATE:
    "Replaced with the effective date chosen on the create form.",
  JURISDICTION:
    "Replaced with the governing-law jurisdiction (e.g. 'State of Delaware').",
  DEAL_NAME:
    "Replaced with the deal's project name or target on the create form.",
  FIRM_NAME:
    "Replaced with your firm's legal name from settings.",
  TODAY:
    "Replaced with today's date when the NDA is generated.",
};

// Wrap a token key in the `[TOKEN_KEY]` syntax the backend looks for.
export function tokenLiteral(key: TokenKey): string {
  return `[${key}]`;
}

// Marker the user drops to choose where the signature field goes. Not a value
// token (no entry in TOKEN_KEYS) — it's structural: the backend swaps it for a
// Dropbox text-tag block on "Send for signature" or a visible signature line
// on email. Mirrors SIGNATURE_BLOCK_MARKER in
// apps/api/src/services/legalDocSignatureBlock.ts — keep the two in sync.
export const SIGNATURE_BLOCK_MARKER = "[SIGNATURE_BLOCK]";

// Returns the subset of TOKEN_KEYS present in the given HTML body, in the
// same order as TOKEN_KEYS. The template verifier uses this both to compute
// `placeholderKeys` on save and to render the "tokens present" checklist.
export function detectTokens(html: string | null | undefined): TokenKey[] {
  if (!html) return [];
  return TOKEN_KEYS.filter((k) => html.includes(tokenLiteral(k)));
}
