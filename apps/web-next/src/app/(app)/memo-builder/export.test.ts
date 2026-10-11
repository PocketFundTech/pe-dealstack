/**
 * QA 2026-10-06 #16c: memo PDF export used to rasterize the page with
 * html2pdf.js/html2canvas, producing an image-only PDF (not searchable or
 * copyable). exportMemoPDF now writes real text via jsPDF. These tests cover
 * the plain-text layout helper directly, and that exportMemoPDF calls
 * jsPDF's text API (never an image-embedding API) with real section text.
 */
import { describe, it, expect, vi } from "vitest";
import { htmlToPlainTextWithLayout, exportMemoPDF, exportMemoClipboard, exportMemoMarkdown } from "./export";
import type { Memo, MemoSection } from "./components";

describe("htmlToPlainTextWithLayout", () => {
  it("turns paragraphs into blank-line-separated text with no HTML tags", () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    const text = htmlToPlainTextWithLayout(html);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("turns list items into bulleted lines", () => {
    const html = "<ul><li>Alpha</li><li>Beta</li></ul>";
    const text = htmlToPlainTextWithLayout(html);
    expect(text).toContain("• Alpha");
    expect(text).toContain("• Beta");
  });

  it("strips inline formatting tags without leaving markdown syntax behind", () => {
    const html = "<p>Revenue grew <strong>40%</strong> year over year.</p>";
    const text = htmlToPlainTextWithLayout(html);
    expect(text).toBe("Revenue grew 40% year over year.");
    expect(text).not.toContain("**");
  });

  it("decodes HTML entities", () => {
    const html = "<p>Margins &amp; multiples &gt; 5x</p>";
    expect(htmlToPlainTextWithLayout(html)).toBe("Margins & multiples > 5x");
  });
});

describe("exportMemoPDF", () => {
  it("writes real text (not an image) for the title and every section", async () => {
    const textCalls: string[] = [];
    const addImageCalls: unknown[] = [];
    function FakeJsPDF() {
      return {
        internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
        setFont: vi.fn(),
        setFontSize: vi.fn(),
        setTextColor: vi.fn(),
        splitTextToSize: (text: string) => text.split("\n"),
        text: (line: string) => { textCalls.push(line); },
        addPage: vi.fn(),
        addImage: (...args: unknown[]) => { addImageCalls.push(args); },
        save: vi.fn(),
      };
    }
    const jsPDFCtor = vi.fn(FakeJsPDF);
    vi.doMock("jspdf", () => ({ jsPDF: jsPDFCtor }));
    const { exportMemoPDF: exportWithMock } = await import("./export");

    const memo = { id: "m1", title: "IC Memo", projectName: "Acme Deal" } as Memo;
    const sections: MemoSection[] = [
      { id: "s1", type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>Strong deal.</p>", sortOrder: 1 } as MemoSection,
    ];

    await exportWithMock(memo, sections, {});

    expect(addImageCalls).toHaveLength(0); // never rasterized
    expect(textCalls.some((l) => l.includes("Acme Deal"))).toBe(true);
    expect(textCalls.some((l) => l.includes("Executive Summary"))).toBe(true);
    expect(textCalls.some((l) => l.includes("Strong deal."))).toBe(true);
    vi.doUnmock("jspdf");
  });
});

describe("exports never include a failed-generation placeholder", () => {
  const RAW = '[Section generation failed: 400 {"type":"error","error":{"message":"Your credit balance is too low"},"request_id":"req_x"}]';
  const sections = [
    { id: "s1", type: "A", title: "Good", content: "<p>Real text.</p>", sortOrder: 1 },
    { id: "s2", type: "B", title: "Raw", content: RAW, sortOrder: 2 },
    { id: "s3", type: "C", title: "Clean", content: "<p><em>[AI couldn't generate this section: The AI request failed.]</em></p>", sortOrder: 3 },
  ] as MemoSection[];

  it("clipboard", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await exportMemoClipboard(sections, {});
    const out = writeText.mock.calls[0][0] as string;
    expect(out).toContain("Real text.");
    expect(out.match(/\[Section not generated\]/g)).toHaveLength(2);
    expect(out).not.toMatch(/request_id|credit balance|couldn't generate/);
    vi.unstubAllGlobals();
  });

  it("markdown", async () => {
    let blobParts: BlobPart[] = [];
    vi.stubGlobal("Blob", class { constructor(p: BlobPart[]) { blobParts = p; } });
    (URL as any).createObjectURL = vi.fn(() => "blob:x");
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    exportMemoMarkdown({ id: "m", title: "T", projectName: "P" } as Memo, sections, {});
    const out = String(blobParts[0]);
    expect(out).toContain("Real text.");
    expect(out.match(/\[Section not generated\]/g)).toHaveLength(2);
    expect(out).not.toMatch(/request_id|credit balance|couldn't generate/);
    vi.unstubAllGlobals();
  });

  it("pdf", async () => {
    const textCalls: string[] = [];
    const Fake = function () {
      return {
        internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
        setFont: vi.fn(), setFontSize: vi.fn(), setTextColor: vi.fn(),
        splitTextToSize: (t: string) => t.split("\n"),
        text: (l: string) => { textCalls.push(l); },
        addPage: vi.fn(), save: vi.fn(),
      };
    };
    vi.doMock("jspdf", () => ({ jsPDF: vi.fn(Fake) }));
    const { exportMemoPDF: pdf } = await import("./export");
    await pdf({ id: "m", title: "T", projectName: "P" } as Memo, sections, {});
    const out = textCalls.join("\n");
    expect(out).toContain("Real text.");
    expect(out.match(/\[Section not generated\]/g)).toHaveLength(2);
    expect(out).not.toMatch(/request_id|credit balance|couldn't generate/);
    vi.doUnmock("jspdf");
  });
});
