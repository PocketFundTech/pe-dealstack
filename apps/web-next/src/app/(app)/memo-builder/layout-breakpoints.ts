/** Viewport width below which the AI Analyst panel starts collapsed. */
export const CHAT_COLLAPSE_BELOW_PX = 1440;

export function shouldStartChatCollapsed(viewportWidth: number): boolean {
  return viewportWidth < CHAT_COLLAPSE_BELOW_PX;
}
