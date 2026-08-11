// User-placed signature blocks for NDA bodies.
//
// The editor lets the user drop a `[SIGNATURE_BLOCK]` marker wherever the
// signature should land (TokenInsertPanel → "Insert signature field"). Both
// send paths swap that marker out just before the document is rendered:
//
//   * eSign (Dropbox Sign)  → hidden text-tag block (signatureBlockHtml).
//       Dropbox reads the tags out of the exported PDF and drops the real
//       signature/date fields there. If the user placed NO marker we append
//       the block at the end, so a signature field always exists.
//   * email (Google Doc)    → a visible signature/date line the counterparty
//       signs by hand. If the user placed NO marker we leave the body alone
//       (the editable Doc has never carried a signature line before).
//
// This module is provider-neutral on purpose — the email path must not import
// from integrations/dropboxSign. The Dropbox-specific hidden-tag markup still
// lives in textTags.ts; we just borrow it for the eSign placement here.

import { signatureBlockHtml } from '../integrations/dropboxSign/textTags.js';

// The literal the editor inserts. Mirrors SIGNATURE_BLOCK_MARKER in
// apps/web-next/src/app/(app)/nda/constants.ts — keep the two in sync.
export const SIGNATURE_BLOCK_MARKER = '[SIGNATURE_BLOCK]';

// Matches a paragraph whose ONLY content is the marker (plus stray
// whitespace / &nbsp; / <br> the editor leaves behind). We replace the whole
// <p> so the block isn't nested inside it — a <div> inside a <p> is invalid
// HTML and Drive's importer mangles it. The escaped marker text must stay in
// sync with SIGNATURE_BLOCK_MARKER above.
const MARKER_PARAGRAPH_RE =
  /<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*\[SIGNATURE_BLOCK\](?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi;

// Visible signature/date lines for the hand-signed Google Doc. Underscores
// (not a CSS border) so the line survives Drive's HTML→Doc conversion intact.
export function visibleSignatureBlockHtml(): string {
  return [
    '<div style="margin-top:48px;page-break-inside:avoid;">',
    '<p style="margin:0 0 2px;font-weight:bold;">Signature</p>',
    '<p style="margin:0 0 24px;">______________________________</p>',
    '<p style="margin:0 0 2px;font-weight:bold;">Date</p>',
    '<p style="margin:0;">__________________</p>',
    '</div>',
  ].join('');
}

// Swap every marker for a freshly-built block. `blockFor(index)` is called once
// per marker with a 0-based index, so the eSign path can give each field a
// unique id (the email path ignores it). Standalone-paragraph markers (the
// common case — the button inserts the marker as its own <p>) have their whole
// <p> replaced; any leftover inline marker is replaced one at a time. When no
// marker exists, append a single block only if `appendIfMissing`.
function placeBlock(
  html: string,
  blockFor: (index: number) => string,
  appendIfMissing: boolean,
): string {
  if (!html.includes(SIGNATURE_BLOCK_MARKER)) {
    return appendIfMissing ? html + blockFor(0) : html;
  }
  let index = 0;
  let out = html.replace(MARKER_PARAGRAPH_RE, () => blockFor(index++));
  // A plain-string replace() hits only the first match, so loop to give every
  // leftover inline marker its own index.
  while (out.includes(SIGNATURE_BLOCK_MARKER)) {
    out = out.replace(SIGNATURE_BLOCK_MARKER, () => blockFor(index++));
  }
  return out;
}

// eSign path: marker → hidden Dropbox text tags (one unique field id each);
// append at end if none placed.
export function placeEsignSignatureBlock(html: string): string {
  return placeBlock(html, (index) => signatureBlockHtml(index), true);
}

// Email path: marker → visible signature line; leave the body untouched if
// none placed (preserves the pre-existing "editable Doc has no signature line"
// behaviour).
export function placeVisibleSignatureBlock(html: string): string {
  return placeBlock(html, () => visibleSignatureBlockHtml(), false);
}
