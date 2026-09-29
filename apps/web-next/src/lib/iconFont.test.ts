/**
 * The icon font is subset to ICON_NAMES (see iconFont.ts). An icon used in
 * the UI but missing from that list renders as its name in plain text, so
 * this scans the source for icon names and fails on any that aren't listed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ICON_NAMES, ICON_FONT_URL } from "./iconFont";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const NAME = "([a-z][a-z0-9_]*)";
const PATTERNS = [
  // <span className="material-symbols-outlined ...">name</span>
  new RegExp(`material-symbols-outlined[^>]*>\\s*${NAME}\\s*<`, "g"),
  // Same, when the span's attributes hold an arrow function (the `=>` ends
  // the match above early): a lone lowercase word on its own line in a span.
  new RegExp(`>\\s*\\n\\s*${NAME}\\s*\\n\\s*</span>`, "g"),
  // icon="name", iconName="name"
  new RegExp(`\\bicon[A-Za-z]*=["']${NAME}["']`, "g"),
  // { icon: "name" }
  new RegExp(`\\bicon[A-Za-z]*:\\s*["']${NAME}["']`, "g"),
  // {deal.icon || "name"}
  new RegExp(`icon\\s*\\|\\|\\s*["']${NAME}["']`, "g"),
];
// <span className="material-symbols-outlined ...">{cond ? "a" : "b"}</span>
const EXPRESSION = /material-symbols-outlined[^>]*>\{([^}]*)\}/g;

function iconNamesInSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) found.set(m[1], file);
    }
    for (const m of text.matchAll(EXPRESSION)) {
      for (const lit of m[1].matchAll(/["']([a-z][a-z0-9_]*)["']/g)) found.set(lit[1], file);
    }
  }
  return found;
}

describe("icon font subset", () => {
  it("includes every icon the source uses", () => {
    const listed = new Set<string>(ICON_NAMES);
    const missing = [...iconNamesInSource()]
      .filter(([name]) => !listed.has(name))
      .map(([name, file]) => `${name} (${file.replace(SRC, "src")})`);
    expect(missing).toEqual([]);
  });

  it("keeps the list sorted and unique (Google Fonts rejects unsorted icon_names)", () => {
    expect([...ICON_NAMES]).toEqual([...new Set(ICON_NAMES)].sort());
  });

  it("requests the subset, not the whole font", () => {
    expect(ICON_FONT_URL).toContain("icon_names=");
  });
});
