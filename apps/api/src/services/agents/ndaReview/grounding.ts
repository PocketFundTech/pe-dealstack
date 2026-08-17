// ─── NDA review grounding ─────────────────────────────────────────
// Every finding that quotes the NDA must quote it VERBATIM. This module
// checks that claim against the parsed document before anything is shown
// to a user or written to the database.
//
// Why this exists: a review that quotes language which isn't in the
// contract is worse than no review — it's a confident fabrication about a
// document someone is about to sign. Julian (demo call M12) named exactly
// this failure mode as trust-breaking, and it's the behaviour our /security
// page commits against.
//
// Findings that fail are KEPT and flagged, never silently dropped: a
// disappearing finding hides a misbehaving model, whereas a flagged one is
// visible to the user and countable in the logs.

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&rsquo;/g, '’'],
  [/&lsquo;/g, '‘'],
  [/&rdquo;/g, '”'],
  [/&ldquo;/g, '“'],
  [/&mdash;/g, '—'],
  [/&ndash;/g, '–'],
];

/** Strip tags and decode entities so quotes can be matched against prose. */
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Normalise for comparison only — never for display.
 *
 * Reflowing a quote onto one line is not fabrication, so whitespace is
 * collapsed and the typographic quote/dash variants a model tends to
 * "tidy up" are folded onto their ASCII forms. Digits, words and numbers
 * are left strictly alone: "five (5) years" must not match "seven (7)
 * years", which is precisely the error that matters most and is hardest
 * to catch by eye.
 */
function normaliseForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface QuotableFinding {
  clauseKey: string;
  status: string;
  quotedText: string;
  [key: string]: unknown;
}

export type VerifiedFinding<T extends QuotableFinding> = T & { quoteVerified: boolean };

/**
 * Mark each finding with whether its quote actually appears in the source.
 *
 * A MISSING finding has nothing to quote, so it passes by definition — the
 * model asserting a clause is absent is a claim about the whole document,
 * not about a span of it.
 */
export function verifyQuotes<T extends QuotableFinding>(
  findings: T[],
  sourceHtml: string,
): Array<VerifiedFinding<T>> {
  const haystack = normaliseForMatch(htmlToPlainText(sourceHtml));

  return findings.map((finding) => {
    const quote = (finding.quotedText ?? '').trim();

    if (finding.status === 'MISSING' || quote.length === 0) {
      return { ...finding, quoteVerified: true };
    }

    const needle = normaliseForMatch(quote);
    return { ...finding, quoteVerified: needle.length > 0 && haystack.includes(needle) };
  });
}
