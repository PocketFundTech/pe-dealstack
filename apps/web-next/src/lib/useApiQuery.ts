"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * useApiQuery — a tiny, zero-dependency stale-while-revalidate cache for GET
 * requests (Phase 3 of the page-load perf work).
 *
 * Why: pages were client components that fetch on mount → show a spinner →
 * render. Revisiting a page re-ran the whole fetch and showed the spinner
 * again. This hook keeps a module-level cache keyed by request path, so:
 *   - revisiting a page renders the cached data INSTANTLY (no spinner), then
 *     revalidates in the background;
 *   - concurrent callers for the same key share one in-flight request;
 *   - mutations can update or invalidate the cache so the UI stays correct.
 *
 * It is intentionally small (not SWR/React Query) so it adds no dependency and
 * is easy to reason about. Use it for read-only GETs; keep using `api.post/
 * patch/delete` for mutations and call `mutate()`/`invalidateApiCache()` after.
 *
 * State (data / error / isValidating) lives in a module-level store and is read
 * through useSyncExternalStore, so there is no setState-in-effect and every
 * subscriber for a key stays in sync.
 */

interface QueryState<T> {
  data: T | undefined;
  error: Error | null;
  isValidating: boolean;
  /** Timestamp of the last successful fetch (0 = never). */
  ts: number;
}

const EMPTY: QueryState<unknown> = {
  data: undefined,
  error: null,
  isValidating: false,
  ts: 0,
};

const store = new Map<string, QueryState<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<() => void>>();

function getState(key: string): QueryState<unknown> {
  return store.get(key) ?? EMPTY;
}

function setState(key: string, patch: Partial<QueryState<unknown>>): void {
  const prev = store.get(key) ?? EMPTY;
  store.set(key, { ...prev, ...patch });
  const subs = subscribers.get(key);
  if (subs) for (const cb of subs) cb();
}

function subscribe(key: string, cb: () => void): () => void {
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(cb);
  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) subscribers.delete(key);
  };
}

/**
 * Imperatively seed/replace a cache entry (e.g. after a mutation). Accepts a
 * value or an updater `(prev) => next` for optimistic edits keyed off the
 * current cached data.
 */
export function mutateApiCache<T>(
  key: string,
  data: T | ((prev: T | undefined) => T),
): void {
  const prev = store.get(key)?.data as T | undefined;
  const next =
    typeof data === "function" ? (data as (p: T | undefined) => T)(prev) : data;
  setState(key, { data: next, error: null, ts: Date.now() });
}

/** Drop one key (or the whole cache) so the next read refetches. */
export function invalidateApiCache(key?: string): void {
  if (key === undefined) {
    const keys = [...store.keys()];
    store.clear();
    for (const k of keys) {
      const subs = subscribers.get(k);
      if (subs) for (const cb of subs) cb();
    }
  } else {
    store.delete(key);
    const subs = subscribers.get(key);
    if (subs) for (const cb of subs) cb();
  }
}

/** Fetch a key through the shared in-flight map so concurrent callers dedupe. */
function fetchKey<T>(key: string): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  setState(key, { isValidating: true, error: null });
  const p = api
    .get<T>(key)
    .then((data) => {
      inflight.delete(key);
      setState(key, { data, error: null, isValidating: false, ts: Date.now() });
      return data;
    })
    .catch((err: unknown) => {
      inflight.delete(key);
      setState(key, {
        error: err instanceof Error ? err : new Error(String(err)),
        isValidating: false,
      });
      throw err;
    });

  inflight.set(key, p);
  return p as Promise<T>;
}

export interface UseApiQueryOptions {
  /** When false (or key is null), the hook is inert — no fetch, no subscribe. */
  enabled?: boolean;
  /** If a cached entry is younger than this (ms), skip background revalidation. */
  staleTime?: number;
}

export interface UseApiQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  /** True when there is no cached data yet and no error — i.e. first load. */
  isLoading: boolean;
  /** True whenever a request is in flight (even if stale data is shown). */
  isValidating: boolean;
  /** Force a revalidation; resolves with fresh data (or undefined on error). */
  refetch: () => Promise<T | undefined>;
  /** Replace this key's cached data locally (value or updater) — optimistic edits. */
  mutate: (data: T | ((prev: T | undefined) => T)) => void;
}

export function useApiQuery<T>(
  key: string | null,
  options: UseApiQueryOptions = {},
): UseApiQueryResult<T> {
  const { enabled = true, staleTime = 0 } = options;
  const active = enabled && key !== null;

  const state = useSyncExternalStore<QueryState<unknown>>(
    useCallback(
      (cb) => (active && key ? subscribe(key, cb) : () => {}),
      [active, key],
    ),
    () => (active && key ? getState(key) : EMPTY),
    () => EMPTY,
  );

  // Revalidate whenever the key becomes active or changes. Only triggers the
  // fetch — all state transitions happen in the store, not via setState here.
  useEffect(() => {
    if (!active || !key) return;
    const entry = store.get(key);
    const isFresh = entry && staleTime > 0 && entry.ts > 0 && Date.now() - entry.ts < staleTime;
    if (isFresh) return;
    fetchKey<T>(key).catch(() => {
      /* error is captured in the store; nothing to do here */
    });
  }, [active, key, staleTime]);

  const refetch = useCallback((): Promise<T | undefined> => {
    if (!key) return Promise.resolve(undefined);
    return fetchKey<T>(key).catch(() => undefined);
  }, [key]);

  const mutate = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      if (key) mutateApiCache(key, next);
    },
    [key],
  );

  const data = state.data as T | undefined;
  return {
    data,
    error: state.error,
    isLoading: active && data === undefined && state.error === null,
    isValidating: state.isValidating,
    refetch,
    mutate,
  };
}
