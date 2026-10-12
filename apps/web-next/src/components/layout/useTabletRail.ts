import { useEffect } from "react";

/** iPad-portrait range: below Tailwind `md` the sidebar is hidden, from `lg` up it has room. */
export const TABLET_QUERY = "(min-width: 768px) and (max-width: 1023px)";

/**
 * Calls `onEnter` on mount (if already in the tablet range) and whenever the
 * viewport crosses into it, so the sidebar can start as an icon rail.
 * The user can still expand it afterwards via the toggle.
 */
export function useTabletRail(onEnter: () => void): void {
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(TABLET_QUERY);
    if (mq.matches) onEnter();
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) onEnter();
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [onEnter]);
}
