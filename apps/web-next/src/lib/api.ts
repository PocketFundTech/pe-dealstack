import { createClient } from "@/lib/supabase/client";

// All API calls go through Next's rewrite at /api/* → API origin (configured via
// API_PROXY_URL in next.config.ts). This keeps fetches same-origin in every
// environment so no CORS config is needed. Do NOT point this at an absolute
// cross-origin URL unless you've also configured CORS on the API.
const API_BASE_URL = "/api";

// Typed error for 404 responses so callers can distinguish "endpoint not found
// yet" from real errors and fail gracefully (empty state, no retry).
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

// Typed error for non-OK responses that preserves the API's `code` field so
// callers can branch on intent (e.g. `INVITE_SELF`) without parsing message
// strings.
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function getAuthHeaders(): Promise<HeadersInit> {
  const supabase = createClient();
  // Use getUser() — getSession() reads from local storage without server
  // validation (Supabase docs warn against relying on it for auth checks).
  // We still need the session for the access_token, but only fetch it after
  // confirming the user is valid.
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { "Content-Type": "application/json" };
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Once the org-level 2FA enforcement has fired, every protected endpoint will
// keep returning 403 MFA_REQUIRED. Tracking a module-level flag lets us
// short-circuit subsequent requests so we don't spam the network tab and
// console with identical failures while the lockout screen is up.
let mfaLockoutActive = false;

function triggerMfaLockout(message: string): never {
  mfaLockoutActive = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pf:mfa-required"));
  }
  throw new ApiError(message, 403, "MFA_REQUIRED");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (mfaLockoutActive) {
    triggerMfaLockout("Two-factor authentication is required by your organization");
  }

  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  // DELETE endpoints return 204 No Content with empty body
  if (res.status === 204) {
    return undefined as T;
  }

  if (res.status === 404) {
    throw new NotFoundError(`Not found: ${path}`);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const message =
      (body as { error?: string; message?: string }).error ||
      (body as { message?: string }).message ||
      res.statusText ||
      `API error ${res.status}`;
    const code = (body as { code?: string }).code;

    // Org has enforced 2FA but the user hasn't enrolled. Surface a full-page
    // lockout via MfaLockoutGate instead of letting individual sections fail
    // — see apps/web-next/src/components/layout/MfaLockoutGate.tsx.
    if (res.status === 403 && code === "MFA_REQUIRED") {
      triggerMfaLockout(message);
    }

    throw new ApiError(message, res.status, code);
  }

  return res.json();
}

export type StreamEventHandler = (event: Record<string, unknown>) => void;

async function requestStream(path: string, body: unknown, onEvent: StreamEventHandler): Promise<void> {
  if (mfaLockoutActive) {
    triggerMfaLockout("Two-factor authentication is required by your organization");
  }

  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { ...headers, Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (res.status === 404) {
    throw new NotFoundError(`Not found: ${path}`);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({} as Record<string, unknown>));
    const message =
      (errBody as { error?: string; message?: string }).error ||
      (errBody as { message?: string }).message ||
      res.statusText ||
      `API error ${res.status}`;
    const code = (errBody as { code?: string }).code;

    if (res.status === 403 && code === "MFA_REQUIRED") {
      triggerMfaLockout(message);
    }

    throw new ApiError(message, res.status, code);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          onEvent(JSON.parse(dataLine.slice(6)));
        } catch (err) {
          console.warn("[api.stream] failed to parse SSE frame:", err);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  stream: (path: string, body: unknown, onEvent: StreamEventHandler) => requestStream(path, body, onEvent),
};
