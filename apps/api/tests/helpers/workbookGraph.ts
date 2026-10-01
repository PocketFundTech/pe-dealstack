import type ExcelJS from 'exceljs';

const f = (v: unknown) => (v as { formula?: string })?.formula ?? '';

/** Static dependency graph over every formula (IF branches included) → first cycle found, or null. */
export function findCycle(book: ExcelJS.Workbook): string | null {
  const colNum = (c: string) => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const colLet = (n: number) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const edges = new Map<string, string[]>();
  const REF = /(?:([A-Za-z]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?/g;
  book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
    const formula = f(cell.value).replace(/"[^"]*"/g, '');
    if (!formula) return;
    const deps: string[] = [];
    for (const m of formula.matchAll(REF)) {
      const sh = m[1] ?? ws.name;
      const [c1, r1, c2, r2] = [colNum(m[2]), +m[3], colNum(m[4] ?? m[2]), +(m[5] ?? m[3])];
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) deps.push(`${sh}!${colLet(c)}${r}`);
    }
    edges.set(`${ws.name}!${cell.address}`, deps);
  })));
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): string | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return n;
    state.set(n, 1);
    for (const d of edges.get(n) ?? []) { const hit = visit(d); if (hit) return hit; }
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) { const hit = visit(n); if (hit) return hit; }
  return null;
}
