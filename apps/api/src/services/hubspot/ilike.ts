/**
 * Escape a value for an exact, case-insensitive `.ilike()` match.
 *
 * `.ilike(column, value)` is a LIKE pattern: `%` and `_` in the value are
 * wildcards, so a company called "100% Growth" or "my_co" matched other
 * rows too, and the import could link a record to the wrong one. Escaping
 * `\`, `%` and `_` (Postgres's default LIKE escape is `\`) makes it a plain
 * case-insensitive equality.
 *
 * Kept in its own module (not dedup.ts) because several engine tests mock
 * dedup.js wholesale.
 */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
