/**
 * Every hard-coded internal link must point at a route that exists.
 * Bulk import's "View All Deals" button linked to /crm, which has no page,
 * so users landed on a 404 right after a successful import.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const APP = join(SRC, "app");
const PUBLIC = join(SRC, "..", "public");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Top-level URL segments served by the app: route folders, looking through (groups). */
function routeSegments(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) return [];
    if (name.startsWith("(")) return routeSegments(path);
    return [name];
  });
}

describe("internal links", () => {
  it("only point at routes that exist", () => {
    const known = new Set(routeSegments(APP));
    // Includes "." so a static file under /public (e.g. /openapi.json) keeps
    // its extension — without it the capture stopped at "/openapi" and the
    // existsSync(PUBLIC, segment) check below could never find the real file.
    const link = /(?:href=|push\(|replace\()["'`](\/[a-zA-Z0-9_.-]+)/g;
    const broken: string[] = [];
    for (const file of files(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(link)) {
        const segment = m[1].slice(1);
        if (known.has(segment) || existsSync(join(PUBLIC, segment))) continue;
        broken.push(`${m[1]} (${file.replace(SRC, "src")})`);
      }
    }
    expect(broken).toEqual([]);
  });
});
