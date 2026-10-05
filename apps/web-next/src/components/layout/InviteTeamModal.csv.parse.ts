// CSV parsing + validation for the BulkCsvImportPanel.
// Extracted so InviteTeamModal.csv.tsx stays under the 500-line cap.
//
// QA #4 (1 Oct 2026): the preview is now an editable table — rows can be
// edited, included/skipped, and given a deal — so validation is a pure
// function of the current rows (validateRows), re-run on every edit.

// Roles accepted by POST /api/invitations/bulk (must match
// apps/api/src/routes/invitations.ts > bulkInviteSchema).
export type BulkRole = "VIEWER" | "MEMBER" | "ADMIN";
export const VALID_ROLES: BulkRole[] = ["VIEWER", "MEMBER", "ADMIN"];
export const ROLE_LABEL: Record<BulkRole, string> = { VIEWER: "Analyst", MEMBER: "Associate", ADMIN: "Admin" };

export const DEFAULT_ROLE: BulkRole = "VIEWER"; // task spec: defaults to ANALYST → VIEWER
export const MAX_BULK_ROWS = 20; // matches API: bulkInviteSchema max(20)

export const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export interface DealOption { id: string; name: string }

// Map a friendly label from the CSV (case-insensitive) to the API enum.
// Accepts both the new labels (Analyst/Associate/Admin) and the raw enum values.
export function normalizeRole(raw: string | undefined): {
  role: BulkRole;
  warning?: string;
} {
  const v = (raw ?? "").trim().toUpperCase();
  if (!v) return { role: DEFAULT_ROLE };
  // Friendly aliases
  const aliasMap: Record<string, BulkRole> = {
    ANALYST: "VIEWER",
    VIEWER: "VIEWER",
    ASSOCIATE: "MEMBER",
    MEMBER: "MEMBER",
    PARTNER: "MEMBER",
    PRINCIPAL: "MEMBER",
    ADMIN: "ADMIN",
  };
  const mapped = aliasMap[v];
  if (mapped) return { role: mapped };
  return {
    role: DEFAULT_ROLE,
    warning: `Unknown role "${raw}", defaulted to Analyst`,
  };
}

export type RowResult =
  | { kind: "sent"; deal?: "on_accept" | "not_saved" }
  | { kind: "exists"; deal?: "added" }
  | { kind: "pending" }
  | { kind: "error"; error?: string }
  | { kind: "skipped"; reason: string };

export interface ParsedRow {
  /** Stable key — survives edits to the email. */
  id: string;
  rowNumber: number; // 1-indexed CSV row (excluding header)
  email: string;
  role: BulkRole;
  /** Deal text as written in the CSV (kept to explain an unmatched name). */
  dealText: string;
  /** Matched / picked deal; null = no deal. */
  dealId: string | null;
  /** Include this row when sending. */
  checked: boolean;
  // Non-fatal note (e.g. unknown role coerced to default).
  note?: string;
  // Result after submission.
  result?: RowResult;
}

/** Split one CSV line, honouring "quoted, fields" and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Case-insensitive exact deal-name match. */
export function matchDeal(text: string, deals: DealOption[]): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return deals.find((d) => d.name.trim().toLowerCase() === t)?.id ?? null;
}

// Strip BOM, trim CR, treat blank lines as skipped.
export function parseCsv(text: string, deals: DealOption[] = []): { rows: ParsedRow[]; topError?: string } {
  const cleaned = text.replace(/^﻿/, "");
  const lines = cleaned.split(/\r?\n/);
  // Find first non-empty line as header.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { rows: [], topError: "CSV is empty" };
  }
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const emailCol = header.indexOf("email");
  if (emailCol === -1) {
    return {
      rows: [],
      topError: 'CSV must contain an "email" column in the header row.',
    };
  }
  const roleCol = header.indexOf("role");
  const dealCol = header.findIndex((h) => h === "deal" || h === "workspace");

  const rows: ParsedRow[] = [];
  let csvRowNum = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.trim().length === 0) continue;
    csvRowNum++;
    const cells = splitCsvLine(raw);
    const email = (cells[emailCol] ?? "").trim();
    const roleRaw = roleCol === -1 ? "" : cells[roleCol] ?? "";
    const dealText = dealCol === -1 ? "" : (cells[dealCol] ?? "").trim();
    const { role, warning } = normalizeRole(roleRaw);

    rows.push({
      id: `r${csvRowNum}`,
      rowNumber: csvRowNum,
      email,
      role,
      dealText,
      dealId: matchDeal(dealText, deals),
      checked: true,
      note: warning,
    });
  }
  return { rows };
}

/**
 * Per-row blocking problems for the current table state. Duplicate emails
 * are flagged on every occurrence after the first INCLUDED one; skipped
 * rows are never errors.
 */
export function validateRows(rows: ParsedRow[]): Map<string, string> {
  const issues = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.checked) continue;
    const email = r.email.trim().toLowerCase();
    if (!email) issues.set(r.id, "Missing email");
    else if (!isValidEmail(email)) issues.set(r.id, "Invalid email");
    else if (seen.has(email)) issues.set(r.id, "Duplicate email in this file");
    else if (r.dealText && !r.dealId) issues.set(r.id, `Deal "${r.dealText}" not found — pick one or choose No deal`);
    if (email) seen.add(email);
  }
  return issues;
}

export type Stage = "upload" | "preview" | "submitting" | "done";
