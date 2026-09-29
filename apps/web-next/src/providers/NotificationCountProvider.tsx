"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { useAuth } from "./AuthProvider";

interface NotificationCountContextType {
  unreadCount: number;
  setUnreadCount: (count: number | ((prev: number) => number)) => void;
  refresh: () => Promise<void>;
}

const NotificationCountContext = createContext<NotificationCountContextType>({
  unreadCount: 0,
  setUnreadCount: () => {},
  refresh: async () => {},
});

// 15s feels real-time enough for new task assignments without spamming the
// notifications endpoint. Was 30s — felt sluggish.
const POLL_INTERVAL_MS = 15_000;
// When polls fail (API unreachable, network drop) back off exponentially —
// 30s, 60s, 120s … capped at 5 min — instead of hammering a dead connection
// and filling the console with a warning every 15s.
const MAX_BACKOFF_MS = 5 * 60_000;

function nextDelay(consecutiveFailures: number): number {
  if (consecutiveFailures === 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

/**
 * Provides the unread notification count to the entire app tree.
 * NotificationPanel and Sidebar both consume this so the badge / dot
 * stay in sync without duplicating polling logic.
 */
export function NotificationCountProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const [unreadCount, setUnreadCount] = useState(0);

  // Consecutive failed polls. Drives the backoff and makes sure a sustained
  // outage produces one console warning, not one per attempt.
  const failuresRef = useRef(0);

  const poll = useCallback(async (): Promise<void> => {
    if (!userId) return;
    try {
      const data = await api.get<{ unreadCount: number }>(
        `/notifications?userId=${encodeURIComponent(userId)}&limit=1`,
      );
      setUnreadCount(data.unreadCount || 0);
      failuresRef.current = 0;
    } catch (err) {
      // Polling failures are not critical — keep last known count.
      if (failuresRef.current === 0) {
        console.warn("[NotificationCountProvider] poll failed — backing off until it recovers:", err);
      }
      failuresRef.current += 1;
    }
  }, [userId]);

  // Public refresh (e.g. after marking notifications read): a fresh attempt.
  const refresh = useCallback(() => poll(), [poll]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Self-scheduling loop instead of setInterval, so the gap can grow while
    // the API is unreachable. Background tabs skip the request but keep the
    // schedule; they catch up immediately when shown again.
    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await poll();
        schedule();
      }, nextDelay(failuresRef.current));
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void poll().then(schedule);
    };

    // poll() only sets state after an awaited fetch — no sync state writes
    // during this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll().then(schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId, poll]);

  return (
    <NotificationCountContext.Provider value={{ unreadCount, setUnreadCount, refresh }}>
      {children}
    </NotificationCountContext.Provider>
  );
}

export function useNotificationCount() {
  return useContext(NotificationCountContext);
}
