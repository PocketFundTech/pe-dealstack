import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

// renderMarkdown is the AI-chat markdown→HTML pipeline. The tests below focus
// on the link-sanitisation behaviour added during the deal-page bug-fix sweep
// (see `sanitizeLinkHref` in markdown.ts). The function itself isn't exported,
// so we exercise it through the public renderMarkdown entry point.

describe("renderMarkdown — link sanitisation", () => {
  it("rewrites legacy `#/foo` hash-router prefixes to `/foo`", () => {
    const html = renderMarkdown("Visit [the deals page](#/deals)");
    expect(html).toContain('href="/deals"');
    expect(html).not.toContain("#/deals");
  });

  it("preserves relative paths to internal app routes", () => {
    const html = renderMarkdown("[Dashboard](/dashboard)");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('target="_self"');
    expect(html).not.toContain('target="_blank"');
  });

  it("normalises bare paths to absolute internal routes", () => {
    const html = renderMarkdown("[settings](settings)");
    // bare 'settings' gets a leading slash so Next.js treats it as a route
    expect(html).toContain('href="/settings"');
    expect(html).toContain('target="_self"');
  });

  it("opens external http/https links in a new tab with rel noopener", () => {
    const html = renderMarkdown("[Avise](https://pocket-fund.com)");
    expect(html).toContain('href="https://pocket-fund.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("blocks javascript: hrefs by collapsing them to `#`", () => {
    // Note: spaces in href cause regex to skip the link; use no-space variant
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    // Should fall back to "#"
    expect(html).toContain('href="#"');
  });

  it("blocks data: and other unsafe schemes", () => {
    const html = renderMarkdown("[bad](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="#"');
  });

  it("escapes HTML in link labels to prevent XSS via the visible text", () => {
    const html = renderMarkdown("[<img onerror=alert(1)>](https://example.com)");
    // The label characters must be escaped — no raw `<img` should make it through.
    expect(html).not.toMatch(/<img\s/);
    expect(html).toContain("&lt;img");
  });
});

describe("renderMarkdown — GFM tables", () => {
  it("renders a header + separator + body table as a real <table>", () => {
    const html = renderMarkdown(
      "| Metric | Value |\n| --- | --- |\n| Revenue | $42.3M |\n| EBITDA | $8.1M |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Metric</th>");
    expect(html).toContain("<th>Value</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>Revenue</td>");
    expect(html).toContain("<td>$42.3M</td>");
    expect(html).toContain("<td>EBITDA</td>");
  });

  it("wraps the table in a scrollable container", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain('class="chat-table-wrap"');
  });

  it("renders a header-only table (no body rows) without erroring", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |");
    expect(html).toContain("<thead>");
    expect(html).not.toContain("<tbody>");
  });

  it("does not treat a pipe-containing sentence without a separator row as a table", () => {
    const html = renderMarkdown("Revenue | EBITDA are both up this quarter.");
    expect(html).not.toContain("<table>");
  });
});

describe("renderMarkdown — ordered lists", () => {
  it("renders numbered markdown as a real <ol>, not <ul>", () => {
    const html = renderMarkdown("1. First step\n2. Second step\n3. Third step");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>First step</li>");
    expect(html).toContain("<li>Second step</li>");
    expect(html).not.toContain("<ul");
  });

  it("keeps bullet lists as <ul>", () => {
    const html = renderMarkdown("- alpha\n- beta");
    expect(html).toContain("<ul");
    expect(html).not.toContain("<ol");
  });
});

describe("renderMarkdown — no stray <br> between list items", () => {
  it("does not insert <br> between consecutive <li> in a bullet list", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).not.toMatch(/<\/li>\s*<br>/);
    expect(html).not.toMatch(/<br>\s*<li>/);
  });

  it("does not insert <br> between consecutive <li> in a numbered list", () => {
    const html = renderMarkdown("1. one\n2. two\n3. three");
    expect(html).not.toMatch(/<\/li>\s*<br>/);
    expect(html).not.toMatch(/<br>\s*<li>/);
  });

  it("still inserts <br> for soft line breaks inside an ordinary paragraph", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toContain("line one<br>line two");
  });
});
