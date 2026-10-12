/**
 * Flatten a LangChain AIMessage `content` to plain text.
 *
 * ChatOpenAI returns a string; ChatAnthropic can return an array of content
 * blocks (text + thinking/tool_use). Only the text blocks are kept so callers
 * that store/return the reply as a string behave the same on either provider.
 */
export function aiMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text ?? '' : ''))
      .join('');
  }
  return '';
}
