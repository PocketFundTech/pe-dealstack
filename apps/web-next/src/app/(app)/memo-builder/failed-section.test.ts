import { describe, it, expect } from "vitest";
import { parseFailedSection, failedSectionMessage, NOT_GENERATED_EXPORT_LINE } from "./failed-section";

const RAW =
  '[Section generation failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_abc"}]';

describe("parseFailedSection", () => {
  it("detects the legacy raw-JSON placeholder as a credit problem", () => {
    const info = parseFailedSection(RAW);
    expect(info?.kind).toBe("credit");
    expect(info?.reason).not.toMatch(/req_|\{|invalid_request/);
  });

  it("detects the legacy placeholder wrapped in HTML with escaped quotes", () => {
    const html = `<p><em>${RAW.replace(/"/g, "&quot;")}</em></p>`;
    expect(parseFailedSection(html)?.kind).toBe("credit");
  });

  it("detects the current friendly placeholder and classifies key/config issues", () => {
    const html =
      "<p><em>[AI couldn't generate this section: AI service (Anthropic) rejected the request: the API key is invalid or missing. This is a configuration issue on our side.]</em></p>";
    expect(parseFailedSection(html)?.kind).toBe("key");
  });

  it("classifies rate limit, unavailable and generic", () => {
    expect(parseFailedSection("[AI couldn't generate this section: AI service (Anthropic) is rate-limiting requests.]")?.kind).toBe("rate_limit");
    expect(parseFailedSection("[AI couldn't generate this section: AI service is temporarily unavailable.]")?.kind).toBe("unavailable");
    expect(parseFailedSection("[AI couldn't generate this section: The AI request failed.]")?.kind).toBe("generic");
  });

  it("returns null for real content, including prose that merely mentions failure", () => {
    expect(parseFailedSection("<p>Revenue grew 40%.</p>")).toBeNull();
    expect(parseFailedSection("<p>The prior section generation failed: we reran it.</p>")).toBeNull();
    expect(parseFailedSection("")).toBeNull();
    expect(parseFailedSection(null)).toBeNull();
  });

  it("builds a message with the reason and next step", () => {
    const msg = failedSectionMessage(parseFailedSection(RAW)!);
    expect(msg).toMatch(/^Not generated: /);
    expect(msg).toMatch(/Click regenerate to try again\.$/);
  });
  it("exposes the export line", () => {
    expect(NOT_GENERATED_EXPORT_LINE).toBe("[Section not generated]");
  });
});
