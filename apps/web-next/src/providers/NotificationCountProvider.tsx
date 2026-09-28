"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

/**
 * Provides the unread notification count to the entire app tree.
 * NotificationPanel and Sidebar both consume this so the badge / dot
 * stay in sync without duplicating polling logic.
 */
export function NotificationCountProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await api.get<{ unreadCount: number }>(
        `/notifications?userId=${encodeURIComponent(userId)}&limit=1`,
      );
      setUnreadCount(data.unreadCount || 0);
    } catch (err) {
      // Polling failures are not critical — keep last known count.
      console.warn("[NotificationCountProvider] poll failed:", err);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    // refresh() awaits an async fetch; setInterval invokes it later.
    // Both produce deferred setStates — no sync state writes during this
    // effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    // Don't poll from background tabs: every open tab was hitting the API
    // every 15s forever, competing with the foreground tab's page loads.
    // Catch up immediately when the tab becomes visible again.
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId, refresh]);

  return (
    <NotificationCountContext.Provider value={{ unreadCount, setUnreadCount, refresh }}>
      {children}
    </NotificationCountContext.Provider>
  );
}

export function useNotificationCount() {
  return useContext(NotificationCountContext);
}
