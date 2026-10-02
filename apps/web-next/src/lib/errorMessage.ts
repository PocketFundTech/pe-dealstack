import { ApiError } from "./api";

// Bare status text the API layer falls back to when a response carried no
// reason of its own — it tells the user nothing, so it never reaches them.
const GENERIC_STATUS = /^(API error \d+|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Bad Request)$/i;

/**
 * The sentence to show for a failed request: the server's own reason
 * (api.ts carries it on ApiError), a plain network / timeout message when
 * the request never got a reasoned answer, else `fallback` with the status.
 * Never a bare "Something went wrong".
 */
export function describeLoadError(err: unknown, fallback: string): string {
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection, then retry.";
  if (err instanceof ApiError) {
    if (err.status === 504) return "The server took too long to respond. Retry in a moment.";
    if (!err.message || GENERIC_STATUS.test(err.message)) {
      return `${fallback} (server error ${err.status}). Retry, and contact support if it keeps happening.`;
    }
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
