// Exact-string token replacement for NDA bodies. Real templates use
// VISUAL whitespace gaps for fillable fields, not bracket markers —
// the admin manually wraps the gaps in [TOKEN] markers during the
// verify step, and this service then swaps them for the live values.
//
// No regex, no fuzzy matching: replaceAll with the literal `[TOKEN]`
// string. This keeps substitution predictable and survives templates
// that contain regex metacharacters in their copy.

export const LEGAL_DOC_TOKEN_KEYS = [
  'COUNTERPARTY_NAME',
  'COUNTERPARTY_ADDRESS',
  'COUNTERPARTY_EMAIL',
  'EFFECTIVE_DATE',
  'JURISDICTION',
  'DEAL_NAME',
  'FIRM_NAME',
  'TODAY',
] as const;

export type LegalDocTokenKey = (typeof LEGAL_DOC_TOKEN_KEYS)[number];

export type LegalDocTokenValues = Partial<Record<LegalDocTokenKey, string>>;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Formats a YYYY-MM-DD string (or any ISO-ish date input) as
// "Month DD, YYYY". Returns the original input on parse failure
// so we never silently drop a value the admin typed in.
export function formatLongDate(input: string | undefined | null): string {
  if (!input) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!m) return input;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!month || month < 1 || month > 12) return input;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// Empty-paragraph "fill me" placeholders the parser injects for visual gaps
// (see legalDocParseService.markVisibleGaps). The editor is supposed to have
// a real token dropped into each before send; any left UNFILLED are removed
// here so the counterparty never sees the raw "click here to insert a token"
// stub (or an empty amber gap) in the final Doc.
//
// Runs AFTER token replacement, so a gap the user actually filled now holds a
// real value (e.g. <p class="nda-gap">Acme Corp</p>) — we keep those and only
// drop gaps whose remaining inner text is empty, whitespace, or the underscore
// stub. Scoped to the .nda-gap paragraph; never touches other copy.
const NDA_GAP_PARAGRAPH = /<p\b[^>]*class="[^"]*\bnda-gap\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;

function gapIsUnfilled(inner: string): boolean {
  // Strip any leftover tags (e.g. a stray <br>) and decode the lone &nbsp;
  // the editor leaves behind, then see if anything meaningful remains once
  // underscores/whitespace are removed.
  const text = inner
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/[_\s]/g, '');
  return text.length === 0 || /clickheretoinsertatoken/i.test(text);
}

function stripUnfilledGaps(html: string): string {
  return html.replace(NDA_GAP_PARAGRAPH, (match, inner: string) =>
    gapIsUnfilled(inner) ? '' : match,
  );
}

export function substituteTokens(
  bodyHtml: string,
  tokens: LegalDocTokenValues,
): string {
  let out = bodyHtml;
  for (const key of LEGAL_DOC_TOKEN_KEYS) {
    const raw = tokens[key] ?? '';
    const value = key === 'EFFECTIVE_DATE' || key === 'TODAY'
      ? formatLongDate(raw)
      : raw;
    out = out.replaceAll(`[${key}]`, value);
  }
  // Drop any placeholder gaps the user left unfilled in the editor so their
  // stub text doesn't ship as raw copy.
  out = stripUnfilledGaps(out);
  return out;
}
