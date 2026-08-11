// Dropbox Sign text tags — in-document markers that tell Dropbox where to put
// signer fields, instead of letting it auto-place them at the end of the PDF.
//
// Grammar: [type|req/noreq|signer|label|id]. signer is 1-based (signer1 = the
// first signer in the request), mapping to the 0-based `signers[0]` we send in
// the client. We emit all five segments — a non-empty label plus a unique id —
// so repeated blocks become distinct fields (see signatureBlockHtml).
//
// These markers only take effect when the request is sent with
// use_text_tags=1 (+ hide_text_tags=1 to whiteout the marker text). See
// integrations/dropboxSign/client.ts → sendSignatureRequest.
// Docs: https://developers.hellosign.com/docs/walkthroughs/text-tags

type TextTagType = 'sig' | 'date' | 'initials' | 'text' | 'checkbox';

// 1-based index of the primary (and, for this prototype, only) signer.
const PRIMARY_SIGNER = 'signer1';

// Full five-segment tag: [type|req|signer|label|id].
//   * label — a non-empty field name; an empty `||` segment can make Dropbox
//     silently reject the tag, so we never leave it blank.
//   * id    — unique per field. Dropbox links same-id tags into one field, so
//     distinct ids are what let multiple blocks become multiple fields.
function textTag(
  type: TextTagType,
  required: boolean,
  label: string,
  id: string,
  signer: string = PRIMARY_SIGNER,
): string {
  return `[${type}|${required ? 'req' : 'noreq'}|${signer}|${label}|${id}]`;
}

// Marker text is white so a tag stays invisible even if it slips past Dropbox's
// parser; hide_text_tags=1 (client.ts) whites out the ones it recognises.
//
// The tag font MUST stay <= 12pt: Dropbox silently ignores any larger text tag
// and falls back to auto-placing a single default field — exactly the "only one
// signature field, markers ignored" bug the old 26px `sig` style caused. Field
// size comes from the tag's length, not its font size.
const HIDDEN = 'color:#ffffff;';
const TAG_STYLE = `font-size:11pt;line-height:1.2;${HIDDEN}`;

/**
 * One hidden signature + date field pair. `index` keeps the field ids unique
 * across however many [SIGNATURE_BLOCK] markers the user dropped, so each
 * becomes its own field instead of collapsing into one.
 *
 * Each tag sits alone in its own paragraph: a hide_text_tags requirement, and
 * what lets Dropbox size each field to its own marker.
 */
export function signatureBlockHtml(index = 0): string {
  return [
    '<div style="margin-top:48px;page-break-inside:avoid;">',
    '<p style="margin:0 0 2px;font-weight:bold;">Signature</p>',
    `<p style="margin:0;${TAG_STYLE}">${textTag(
      'sig',
      true,
      'Signature',
      `sig${index}`,
    )}</p>`,
    '<p style="margin:16px 0 2px;font-weight:bold;">Date</p>',
    `<p style="margin:0;${TAG_STYLE}">${textTag(
      'date',
      true,
      'Date',
      `date${index}`,
    )}</p>`,
    '</div>',
  ].join('');
}
