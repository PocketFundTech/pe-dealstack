/**
 * Detects the placeholder the API stores in a memo section when AI generation
 * failed, and turns it into a plain-language reason.
 *
 * Two historical formats exist:
 *  - legacy: `[Section generation failed: 400 {"type":"error",...,"request_id":"req_..."}]`
 *    (raw provider JSON baked into the section)
 *  - current: `<p><em>[AI couldn't generate this section: <friendly message>]</em></p>`
 *
 * Neither is memo content: the canvas shows a "Not generated" state and every
 * export replaces it with {@link NOT_GENERATED_EXPORT_LINE}.
 */

export type FailedSectionKind = "credit" | "key" | "rate_limit" | "unavailable" | "generic";

export interface FailedSectionInfo {
  kind: FailedSectionKind;
  /** Plain-language reason, never the raw provider text. */
  reason: string;
}

/** What exports write in place of a section that was never generated. */
export const NOT_GENERATED_EXPORT_LINE = "[Section not generated]";

const PLACEHOLDER_RE =
  /^\[\s*(?:section generation failed|ai couldn['’]t generate this section)\s*:?([\s\S]*)\]$/i;

function toText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function reasonFor(detail: string): FailedSectionInfo {
  const d = detail.toLowerCase();
  if (/credit balance|credits are exhausted|out of credit|quota|spending limit|usage limit|payment required|billing/.test(d)) {
    return {
      kind: "credit",
      reason: "the AI provider account is out of credit (a billing issue on our side, not a problem with your memo)",
    };
  }
  if (/api key|authentication|unauthorized|workspace|permission|configuration issue|invalid or missing/.test(d)) {
    return {
      kind: "key",
      reason: "the AI service is misconfigured on our side (API key or workspace setting), not a problem with your memo",
    };
  }
  if (/rate[- ]limit|too many requests|429/.test(d)) {
    return { kind: "rate_limit", reason: "the AI service was rate-limiting requests" };
  }
  if (/overloaded|temporarily unavailable|unavailable|timed out|timeout|network|5\d\d/.test(d)) {
    return { kind: "unavailable", reason: "the AI service was temporarily unavailable or timed out" };
  }
  return { kind: "generic", reason: "the AI request failed" };
}

/** Returns info when `content` is a failed-generation placeholder, else null. */
export function parseFailedSection(content: string | null | undefined): FailedSectionInfo | null {
  if (!content) return null;
  const match = PLACEHOLDER_RE.exec(toText(content));
  if (!match) return null;
  return reasonFor(match[1] ?? "");
}

/** The sentence the canvas shows for a failed section. */
export function failedSectionMessage(info: FailedSectionInfo): string {
  return `Not generated: ${info.reason}. Click regenerate to try again.`;
}
