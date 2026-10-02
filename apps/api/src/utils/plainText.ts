/**
 * Turn model markdown into plain text for places that render text verbatim
 * (a <textarea>, a prompt block). QA #13: Firm Context showed "###",
 * "**bold**" and stray blank lines.
 *
 * Line-anchored rules use [ \t], never \s — \s would also eat the newlines
 * between paragraphs.
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/^```[^\n]*\n?/gm, '')                                   // code fences
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, '$1')    // # Heading → Heading
    .replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')         // horizontal rules
    .replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ')                          // * / + bullets → "- "
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')                      // bold
    .replace(/(^|[ \t(])\*(?![ \t])([^*\n]+?)\*(?=[ \t).,;:!?]|$)/gm, '$1$2') // *italic*
    .replace(/(^|[ \t(])_(?![ \t])([^_\n]+?)_(?=[ \t).,;:!?]|$)/gm, '$1$2')   // _italic_
    .replace(/`([^`\n]+)`/g, '$1')                                     // inline code
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')                         // [text](url) → text
    .replace(/^[ \t]*>[ \t]?/gm, '')                                   // blockquotes
    .replace(/[ \t]+$/gm, '')                                          // trailing spaces
    .replace(/\n{3,}/g, '\n\n')                                        // at most one blank line
    .trim();
}
