// ---------------------------------------------------------------------------
// Statement-specific row layout for the Financial Statements table
// ---------------------------------------------------------------------------
//
// Before (fix plan C2): one ORDERED_LINE_ITEMS list for all three
// statements, and every key it didn't know appended after Net Income in
// JSONB key order — so a QuickBooks P&L read "… Net Income, Sand Cos,
// Discounts, Cement Cos, Fly Ash Cos …", and a `goodwill_amortization_754`
// expense pulled a balance-sheet "Goodwill" parent into the P&L.
//
// Now each statement has its own section order; raw accounts are nested
// under the section they belong to (backend `<parent>_<label>` prefix
// first, then keyword rules); keys from another statement never become
// sections; leftovers go into one collapsed "Unclassified accounts" group.

import { LINE_ITEM_LABELS, SUBTOTAL_KEYS, type StatementType } from "./deal-financials-constants";

export type RowKind = "section" | "line" | "subtotal" | "pct" | "group";

export interface LayoutRow {
  key: string;
  label: string;
  kind: RowKind;
  /** Nested account under a section (or the unclassified group). */
  isChild: boolean;
  parent?: string;
}

interface LayoutItem { key: string; kind: Exclude<RowKind, "group"> }

const L = (key: string, kind: LayoutItem["kind"] = "line"): LayoutItem => ({ key, kind });

export const STATEMENT_LAYOUT: Record<StatementType, LayoutItem[]> = {
  INCOME_STATEMENT: [
    L("revenue", "section"),
    L("cogs", "section"),
    L("gross_profit", "subtotal"), L("gross_margin_pct", "pct"),
    L("sga"), L("rd"), L("other_opex"), L("total_opex", "section"),
    L("ebitda", "subtotal"), L("ebitda_margin_pct", "pct"),
    L("da", "section"), L("depreciation"),
    L("ebit", "subtotal"),
    L("interest_expense"), L("other_income", "section"), L("other_expense"),
    L("ebt", "subtotal"),
    L("tax"), L("tax_expense"),
    L("net_income", "subtotal"),
    L("sde", "subtotal"),
  ],
  BALANCE_SHEET: [
    L("cash"), L("accounts_receivable"), L("inventory"), L("other_current_assets"),
    L("total_current_assets", "subtotal"),
    L("ppe_net"), L("goodwill"), L("intangibles"),
    L("total_assets", "subtotal"),
    L("accounts_payable"), L("short_term_debt"), L("other_current_liabilities"),
    L("total_current_liabilities", "subtotal"),
    L("long_term_debt"), L("total_debt"),
    L("total_liabilities", "subtotal"),
    L("total_equity", "subtotal"),
  ],
  CASH_FLOW: [
    L("operating_cf", "subtotal"), L("operating_cash_flow", "subtotal"),
    L("capex", "section"), L("acquisitions"), L("investing_activities", "subtotal"),
    L("debt_repayment"), L("dividends"), L("financing_activities", "subtotal"),
    L("fcf", "subtotal"), L("free_cash_flow", "subtotal"),
    L("net_change_cash", "subtotal"),
  ],
};

export const UNCLASSIFIED_KEY = "__unclassified";

/**
 * Keyword rules for raw P&L accounts that carry no `<parent>_` prefix
 * (QuickBooks-style names from the live extraction path). First match wins,
 * so the specific rules sit above the broad ones.
 */
const INCOME_KEYWORD_RULES: Array<[RegExp, string]> = [
  [/(^|_)(other_income|interest_income|net_other_income|gain|gains)(_|$)/, "other_income"],
  [/(^|_)(discounts?|refunds?|allowances?|returns?|returned|rebates?)(_|$)/, "revenue"],
  [/(amortization|amortisation|depreciation)/, "da"],
  [/(^|_)(cos|cogs|cost_of|costs?_of_(goods|sales|revenue))(_|$)|_cos$|_costs?$|(^|_)(materials?|freight|cement|sand|gravel|fly_ash|aggregates?|additives?|direct_labou?r|subcontract\w*)(_|$)/, "cogs"],
  [/(^|_)(gross_sales|sales|revenues?|income|fees_earned|services)(_|$)/, "revenue"],
  [/(^|_)interest(_|$)/, "interest_expense"],
  [/(^|_)(tax|taxes|income_tax)(_|$)/, "tax"],
  [/(insurance|rent|bad_debts?|salar|wages?|payroll|utilit|office|professional|legal|accounting|advertis|marketing|repairs?|maintenance|travel|fuel|telephone|phone|dues|licen[cs]e|supplies|bank_(charges?|fees)|meals|vehicle|auto|software|subscriptions?|training|postage|expenses?|opex|admin)/, "total_opex"],
];

/** Parents a child may attach to on each statement (layout keys only). */
function parentKeys(statement: StatementType): string[] {
  return STATEMENT_LAYOUT[statement].map((i) => i.key);
}

const RESERVED_CHILD_SUFFIXES = ["source", "pct", "percent", "ratio", "margin", "total", "label", "order"];

/** Longest layout-key prefix `k` is a `<parent>_<label>` child of, on this statement. */
export function findLayoutParent(statement: StatementType, key: string): string | null {
  const keys = parentKeys(statement);
  if (keys.includes(key) || key.endsWith("_source")) return null;
  let best: string | null = null;
  for (const candidate of keys) {
    if (key.startsWith(candidate + "_") && key.length > candidate.length + 1) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  if (!best) return null;
  const last = key.slice(best.length + 1).split("_").pop()!.toLowerCase();
  return RESERVED_CHILD_SUFFIXES.includes(last) ? null : best;
}

/** Where a non-layout key belongs on this statement, or the unclassified group. */
export function classifyAccount(statement: StatementType, key: string): string {
  const byPrefix = findLayoutParent(statement, key);
  if (byPrefix) return byPrefix;
  if (statement === "INCOME_STATEMENT") {
    for (const [re, parent] of INCOME_KEYWORD_RULES) if (re.test(key)) return parent;
  }
  return UNCLASSIFIED_KEY;
}

// Only these short tokens are acronyms — the old "upper-case anything of
// ≤3 letters" rule produced "Fly ASH" and "NET FEE".
const ACRONYMS: Record<string, string> = {
  cos: "COS", cogs: "COGS", rd: "R&D", sga: "SG&A", da: "D&A", ppe: "PP&E", ebitda: "EBITDA",
  ebit: "EBIT", ebt: "EBT", sde: "SDE", ar: "AR", ap: "AP", llc: "LLC", us: "US", usa: "USA",
  hr: "HR", it: "IT", fx: "FX", qb: "QB", vat: "VAT", gst: "GST", ytd: "YTD", ltm: "LTM",
};

export function humanizeKey(key: string): string {
  if (LINE_ITEM_LABELS[key]) return LINE_ITEM_LABELS[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((seg) => ACRONYMS[seg.toLowerCase()] ?? seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(" ");
}

function childLabel(parent: string, key: string): string {
  if (LINE_ITEM_LABELS[key]) return LINE_ITEM_LABELS[key];
  return humanizeKey(key.startsWith(parent + "_") ? key.slice(parent.length + 1) : key);
}

/**
 * Ordered render plan for one statement: layout rows that have data (or
 * children), each followed by its nested accounts, then the unclassified
 * group last.
 */
export function buildStatementRows(statement: StatementType, allKeys: Set<string>): LayoutRow[] {
  const layout = STATEMENT_LAYOUT[statement];
  const layoutKeys = new Set(layout.map((i) => i.key));
  const children = new Map<string, string[]>();

  for (const k of allKeys) {
    if (k.endsWith("_source") || layoutKeys.has(k)) continue;
    const parent = classifyAccount(statement, k);
    children.set(parent, [...(children.get(parent) ?? []), k]);
  }
  children.forEach((arr) => arr.sort());

  const rows: LayoutRow[] = [];
  for (const item of layout) {
    const kids = children.get(item.key) ?? [];
    if (!allKeys.has(item.key) && kids.length === 0) continue;
    rows.push({ key: item.key, label: humanizeKey(item.key), kind: item.kind, isChild: false });
    for (const k of kids) rows.push({ key: k, label: childLabel(item.key, k), kind: "line", isChild: true, parent: item.key });
  }
  const leftovers = children.get(UNCLASSIFIED_KEY) ?? [];
  if (leftovers.length > 0) {
    rows.push({ key: UNCLASSIFIED_KEY, label: `Unclassified accounts (${leftovers.length})`, kind: "group", isChild: false });
    for (const k of leftovers) rows.push({ key: k, label: humanizeKey(k), kind: "line", isChild: true, parent: UNCLASSIFIED_KEY });
  }
  return rows;
}

/**
 * Hide rows with no value in any period (legit zeros stay). Subtotals always
 * show; a parent with no own value shows while any of its children do.
 */
export function hideEmptyRows(rows: LayoutRow[], hasAnyValue: (key: string) => boolean): LayoutRow[] {
  const visibleChildren = new Set(rows.filter((r) => r.isChild && hasAnyValue(r.key)).map((r) => r.key));
  return rows.filter((r) => {
    if (r.isChild) return visibleChildren.has(r.key);
    if (r.kind === "subtotal" || SUBTOTAL_KEYS.has(r.key)) return true;
    if (r.kind !== "group" && hasAnyValue(r.key)) return true;
    return rows.some((c) => c.isChild && c.parent === r.key && visibleChildren.has(c.key));
  });
}
