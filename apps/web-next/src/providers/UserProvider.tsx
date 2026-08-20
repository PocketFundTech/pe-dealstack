"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { api } from "@/lib/api";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import type { AppUser } from "@/types";

interface UserContextType {
  user: AppUser | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

const UserContext = createContext<UserContextType>({
  user: null,
  loading: true,
  refetch: async () => {},
});

function getCachedUser(): AppUser | null {
  try {
    const cached = sessionStorage.getItem(STORAGE_KEYS.userCache);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as Partial<AppUser>;
    // Minimum viable record: we need an id and a non-empty name/email to render.
    if (!parsed?.id || !parsed?.name) return null;
    // Default isInternal to false for cache entries written before the field existed.
    return { ...parsed, isInternal: parsed.isInternal ?? false } as AppUser;
  } catch (err) {
    console.warn("[UserProvider] failed to read cached user from sessionStorage:", err);
    return null;
  }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = getCachedUser();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }
  }, []);

  const fetchUser = async () => {
    try {
      const data = await api.get<{
        id: string;
        name: string;
        email: string;
        title?: string;
        role?: string;
        avatar?: string;
        preferences?: Record<string, unknown>;
        isInternal?: boolean;
        organization?: {
          id: string;
          name: string;
          slug: string;
          logo?: string | null;
          plan?: string;
        } | null;
      }>("/users/me");

      const appUser: AppUser = {
        id: data.id || "",
        name: data.name || data.email?.split("@")[0] || "User",
        email: data.email || "",
        role: data.title || data.role || "Team Member",
        systemRole: (data.role as AppUser["systemRole"]) || "MEMBER",
        avatar: data.avatar || "",
        preferences: data.preferences || {},
        isInternal: data.isInternal ?? false,
        organization: data.organization ?? null,
      };

      setUser(appUser);
      try {
        sessionStorage.setItem(STORAGE_KEYS.userCache, JSON.stringify(appUser));
      } catch (err) {
        // sessionStorage full or blocked — safe to skip.
        console.warn("[UserProvider] failed to cache user to sessionStorage:", err);
      }
    } catch (err) {
      console.warn("[UserProvider] /users/me failed:", err);
    } finally {
      setLoading(false);
    }
  };

  // onAuthStateChange fires on silent token refresh (~1/hr). Skip re-fetching if
  // the authenticated user hasn't actually changed.
  const lastUserIdRef = useRef<string | null>(null);
  const userId = session?.user?.id;
  useEffect(() => {
    if (userId && userId !== lastUserIdRef.current) {
      lastUserIdRef.current = userId;
      fetchUser();
    } else if (!userId) {
      lastUserIdRef.current = null;
    }
  }, [userId]);

  return (
    <UserContext.Provider value={{ user, loading, refetch: fetchUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}
