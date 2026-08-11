// Parses uploaded template files (.docx / .html / .md) into the
// sanitized HTML body we store on LegalDocTemplate.bodyHtml. The
// admin manually marks up placeholders in a second step (verify),
// so this service is pure parse → sanitize — no token detection.
//
// Formatting strategy: preserve as much Word formatting as we can
// (headings, bold, italic, underline, strike, highlights, font color,
// background color, alignment) so the verifier looks like a faithful
// rendering of the uploaded doc — admin's mental model stays intact.
// Sanitization is strict-allowlist for tags + attribute-value regexps
// on inline styles to keep XSS surface tight.

import { createRequire } from 'module';
import mammoth from 'mammoth';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { log } from '../utils/logger.js';

// pdf-parse is CJS-only and ships no types — use createRequire so the
// rest of the file can stay ESM. This mirrors the pattern in
// services/pdfExtractor.ts so we don't introduce a new style.
const requireCjs = createRequire(import.meta.url);
type PdfParseFn = (buffer: Buffer) => Promise<{ text: string }>;
let pdfParseFn: PdfParseFn | null = null;
function loadPdfParse(): PdfParseFn {
  if (!pdfParseFn) {
    pdfParseFn = requireCjs('pdf-parse') as PdfParseFn;
  }
  return pdfParseFn;
}

export type TemplateFileKind = 'docx' | 'html' | 'md' | 'pdf';

/**
 * Escape a string for safe insertion as text inside HTML. PDF text
 * extraction yields raw characters that may include `<`, `>`, `&`,
 * and quotes — without escaping these we'd produce broken markup the
 * sanitiser drops and, worse, give an attacker an HTML-injection
 * surface via a maliciously crafted PDF. The replacement set covers
 * everything `sanitiseLegalDocHtml`'s allowlist would otherwise eat.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class LegalDocParseError extends Error {
  code: 'INVALID_FILE_FORMAT';
  status: number;
  details?: string;
  constructor(message: string, details?: string) {
    super(message);
    this.code = 'INVALID_FILE_FORMAT';
    this.status = 400;
    this.details = details;
  }
}

// Allowlist — broader than memo-builder's because legal docs need to
// preserve Word formatting fidelity (highlights, underlines, alignment,
// colors). Frontend Editor.tsx mirrors this list — broaden both together.
const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u', 's', 'strike', 'mark',
  'sup', 'sub',
  'br', 'hr',
  'div', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'blockquote', 'code', 'pre', 'button',
];
const ALLOWED_ATTRS_PER_TAG: Record<string, string[]> = {
  '*': ['class', 'style', 'title', 'data-source', 'data-page'],
  a: ['href', 'target', 'rel'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
};
// style="..." passes only if every property is on the allowlist below.
// Regexes are deliberately tight — no `url()`, no `expression()`, no
// `attr()` shenanigans. Keeps XSS surface near zero while letting Word
// highlights / colors / alignment through.
const HEX_OR_RGB = /^#[0-9a-fA-F]{3,6}$|^rgba?\([\d,\s.]+\)$/;
const SAFE_NAMED_COLOR = /^(?:yellow|cyan|green|magenta|blue|red|black|white|gray|grey|orange|purple|pink|teal|navy|lime|aqua|silver|maroon|olive)$/i;
const COLOR_RE = new RegExp(`${HEX_OR_RGB.source}|${SAFE_NAMED_COLOR.source}`);
const ALIGN_RE = /^(?:left|right|center|justify|start|end)$/;
const WEIGHT_RE = /^(?:bold|bolder|normal|lighter|[1-9]00)$/;
const ITALIC_RE = /^(?:italic|normal|oblique)$/;
const DECORATION_RE = /^(?:underline|line-through|none)(?:\s+(?:solid|dashed|wavy))?$/;
const SIZE_RE = /^(?:\d{1,2}(?:\.\d+)?(?:em|rem|px|%))$/;

export function sanitiseLegalDocHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS_PER_TAG,
    allowedStyles: {
      '*': {
        color: [COLOR_RE],
        'background-color': [COLOR_RE],
        'text-align': [ALIGN_RE],
        'font-weight': [WEIGHT_RE],
        'font-style': [ITALIC_RE],
        'text-decoration': [DECORATION_RE],
        'font-size': [SIZE_RE],
        'margin-left': [SIZE_RE],
        'margin-right': [SIZE_RE],
        'padding-left': [SIZE_RE],
      },
    },
    disallowedTagsMode: 'discard',
  });
}

// Extended mammoth styleMap — built on top of mammoth's defaults rather
// than replacing them, so headings / bold / italic / lists still work.
// Adds underline + strike + highlight + a few Word-only paragraph styles
// (Title / Subtitle / Quote etc.) that mammoth otherwise discards.
const WORD_STYLE_MAP: string[] = [
  // Run-level character formatting mammoth doesn't preserve by default:
  "r[underline] => u",
  "r[strike] => s",
  "r[highlight='yellow'] => mark.hl-yellow",
  "r[highlight='green'] => mark.hl-green",
  "r[highlight='cyan'] => mark.hl-cyan",
  "r[highlight='magenta'] => mark.hl-magenta",
  "r[highlight='blue'] => mark.hl-blue",
  "r[highlight='red'] => mark.hl-red",
  "r[highlight='darkYellow'] => mark.hl-yellow-dark",
  "r[highlight='darkGreen'] => mark.hl-green-dark",
  // Paragraph styles Word users sometimes pick instead of Heading-N:
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => h2.doc-subtitle:fresh",
  "p[style-name='Heading 7'] => h6:fresh",
  "p[style-name='Heading 8'] => h6:fresh",
  "p[style-name='Heading 9'] => h6:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote.intense:fresh",
  "p[style-name='Caption'] => p.doc-caption:fresh",
  "p[style-name='Subtle Emphasis'] => em",
  "p[style-name='Intense Emphasis'] => strong",
];

// Wraps empty paragraphs (and paragraphs that only contain non-breaking-space
// whitespace) in a visible "fill me" placeholder. PF's NDA template uses
// blank lines as visual gaps for counterparty name / address / effective date
// / jurisdiction etc. — without marking them the admin has nowhere obvious
// to click in the verifier. The .nda-gap class is honored by Editor.tsx via
// a yellow underline so the gaps pop. Frontend Editor's insertHtmlAtCursor
// replaces the placeholder text when a token is dropped in.
function markVisibleGaps(html: string): string {
  return html.replace(
    /<p>(\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi,
    '<p class="nda-gap">__________ click here to insert a token __________</p>',
  );
}

export interface ParseTemplateInput {
  buffer: Buffer;
  kind: TemplateFileKind;
}

export interface ParseTemplateResult {
  bodyHtml: string;
}

export async function parseTemplateFile(
  input: ParseTemplateInput,
): Promise<ParseTemplateResult> {
  const { buffer, kind } = input;
  if (!buffer || buffer.length === 0) {
    throw new LegalDocParseError('Empty upload — no file content received');
  }

  let rawHtml: string;
  try {
    if (kind === 'docx') {
      // ignoreEmptyParagraphs=false preserves the blank lines in PF-style
      // templates where the visual "gaps" (counterparty name, address,
      // effective date, jurisdiction, ...) live. Default behaviour silently
      // discards them, leaving the admin no visible cursor target in the
      // verifier. We mark them with an underscored placeholder post-parse
      // so they're obviously clickable + token-insertable.
      //
      // Style map captures Word formatting mammoth otherwise drops:
      //   - Underline runs → <u> (default ignores)
      //   - Strike runs → <s>
      //   - Highlights (yellow/green/cyan/magenta/blue/red) → <mark>
      //     with a class so the editor can color them
      //   - Word "Title" / "Subtitle" / "Quote" / "Intense Quote" /
      //     "Caption" paragraph styles → semantic HTML
      const result = await mammoth.convertToHtml(
        { buffer },
        {
          ignoreEmptyParagraphs: false,
          styleMap: WORD_STYLE_MAP,
        } as Parameters<typeof mammoth.convertToHtml>[1],
      );
      rawHtml = markVisibleGaps(result.value);
    } else if (kind === 'html') {
      rawHtml = buffer.toString('utf-8');
    } else if (kind === 'md') {
      // marked.parse returns string | Promise<string> depending on async mode;
      // we always await to normalise.
      const parsed = await Promise.resolve(marked.parse(buffer.toString('utf-8')));
      rawHtml = typeof parsed === 'string' ? parsed : String(parsed);
    } else if (kind === 'pdf') {
      const pdfParse = loadPdfParse();
      const result = await pdfParse(buffer);
      // PDF text extraction is structureless — no headings, no bold, no
      // lists. We get plain text with paragraph-style line breaks. Split
      // on blank-line boundaries (>=2 consecutive newlines) so paragraphs
      // survive, escape each segment, and wrap in <p>. Skip the empty-gap
      // marker that's docx-specific: PDF text has no `<p></p>` shells, and
      // PF-style placeholder gaps don't survive PDF export anyway.
      const paragraphs = (result.text ?? '')
        .split(/\n{2,}/)
        .map((p: string) => p.replace(/\s+$/g, '').replace(/^\s+/g, ''))
        .filter(Boolean);
      rawHtml = paragraphs
        .map((p: string) => `<p>${escapeHtml(p)}</p>`)
        .join('\n');
    } else {
      throw new LegalDocParseError(`Unsupported file kind: ${kind as string}`);
    }
  } catch (err) {
    if (err instanceof LegalDocParseError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('legalDocParseService: parse failed', { kind, message });
    throw new LegalDocParseError(
      `Failed to parse ${kind} template`,
      message,
    );
  }

  if (!rawHtml || !rawHtml.trim()) {
    throw new LegalDocParseError(
      `Parsed ${kind} template was empty after extraction`,
    );
  }

  const bodyHtml = sanitiseLegalDocHtml(rawHtml);
  return { bodyHtml };
}
