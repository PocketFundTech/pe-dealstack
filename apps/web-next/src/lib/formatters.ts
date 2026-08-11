// ISO 4217 → display symbol. Port of CURRENCY_SYMBOLS in
// formatters.js. Unknown codes fall through to "<CODE> ".
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
  CAD: "C$", AUD: "A$", CHF: "CHF ", SGD: "S$", HKD: "HK$",
  AED: "AED ", SAR: "SAR ", BRL: "R$", KRW: "₩", ZAR: "R",
  MXN: "MX$", SEK: "kr", NOK: "kr", DKK: "kr", PLN: "zł",
  THB: "฿", MYR: "RM", IDR: "Rp", PHP: "₱", VND: "₫",
};

export function getCurrencySymbol(currency?: string | null): string {
  if (!currency) return "$";
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase() + " ";
}

/**
 * Values are stored in millions of the original currency in the database.
 * Display unit depends on the currency:
 *   INR: Cr (crore = 10M), L (lakh = 0.1M)
 *   everything else (USD/EUR/GBP/…): B / M / K
 *
 * The currency argument is optional and defaults to USD for backward
 * compatibility with call sites that predate the multi-currency port.
 */
export function formatCurrency(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return "\u2014";
  const sym = getCurrencySymbol(currency);
  const absValue = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const code = (currency || "USD").toUpperCase();

  // INR — Crore / Lakh system. absValue is in millions: 1 Cr = 10M, 1 L = 0.1M.
  if (code === "INR") {
    const crores = absValue / 10;
    if (crores >= 1) {
      return sign + sym + (crores >= 100 ? crores.toFixed(0) : crores >= 10 ? crores.toFixed(1) : crores.toFixed(2)) + "Cr";
    }
    const lakhs = absValue * 10;
    if (lakhs >= 1) {
      return sign + sym + (lakhs >= 100 ? lakhs.toFixed(0) : lakhs >= 10 ? lakhs.toFixed(1) : lakhs.toFixed(2)) + "L";
    }
    const rupees = absValue * 1_000_000;
    return sign + sym + rupees.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  // USD/EUR/GBP/all others — B / M / K.
  if (absValue >= 1000) {
    const b = absValue / 1000;
    return sign + sym + (b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + "B";
  }
  if (absValue >= 1) {
    return sign + sym + (absValue >= 100 ? absValue.toFixed(0) : absValue >= 10 ? absValue.toFixed(1) : absValue.toFixed(2)) + "M";
  }
  const k = absValue * 1000;
  if (k >= 1) {
    return sign + sym + (k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(1) : k.toFixed(2)) + "K";
  }
  const base = absValue * 1_000_000;
  return sign + sym + base.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatNumber(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return "\u2014";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ---------------------------------------------------------------------------
// Display-unit helpers for chart axes
//
// Chart tick callbacks render every value at a SINGLE pre-picked unit, unlike
// `formatFinancialValue` which auto-scales B/M/K per-value. The producer of
// a chart spec sets the unit once; ticks then share a consistent suffix.
// ---------------------------------------------------------------------------

/**
 * Value already-scaled at a known magnitude.
 *
 *   "K"     \u2014 currency in thousands  (e.g. 6.9 \u2192 "$6.9K")
 *   "M"     \u2014 currency in millions   (e.g. 2.6 \u2192 "$2.6M")
 *   "B"     \u2014 currency in billions   (e.g. 1.2 \u2192 "$1.2B")
 *   "units" \u2014 raw currency amount    (e.g. 6900 \u2192 "$6,900")
 *   "%"     \u2014 percentage, no $ prefix (e.g. 12.5 \u2192 "12.5%", -30.6 \u2192 "-30.6%")
 *             Use for margins, growth rates, ratios.
 *   "x"     \u2014 multiplier, no $ prefix (e.g. 8.5 \u2192 "8.5x", 12 \u2192 "12x")
 *             Use for EV/EBITDA, EV/Revenue, P/E, and other multiples.
 */
export type DisplayUnit = "K" | "M" | "B" | "units" | "%" | "x";

const DISPLAY_UNIT_SUFFIX: Record<DisplayUnit, string> = {
  K: "K", M: "M", B: "B", units: "", "%": "%", x: "x",
};

/**
 * Format a value already-scaled at `unit` for a chart axis/tick label.
 * Honours the caller-supplied unit verbatim \u2014 no magnitude auto-pick.
 *
 *   formatChartAxisValue(6.9, "K")      -> "$6.9K"
 *   formatChartAxisValue(6.9, "M")      -> "$6.9M"
 *   formatChartAxisValue(6900, "units") -> "$6,900"
 *   formatChartAxisValue(12.5, "%")     -> "12.5%"
 *   formatChartAxisValue(-30.6, "%")    -> "-30.6%"
 */
export function formatChartAxisValue(
  value: number | null | undefined,
  unit: DisplayUnit = "M",
  options?: { currency?: string | null; precision?: number },
): string {
  if (value === null || value === undefined) return "\u2014";
  const n = Number(value);
  if (!Number.isFinite(n)) return "\u2014";

  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const p = options?.precision ?? 1;

  // Percentages + multipliers skip the currency symbol entirely \u2014 they
  // aren't money. Suffix differs ('%' vs 'x') but the numeric formatting
  // is identical.
  if (unit === "%" || unit === "x") {
    const body =
      abs >= 100 ? abs.toFixed(0)
      : abs >= 10 ? abs.toFixed(Math.min(p, 1))
      : abs.toFixed(p);
    return sign + body + unit;
  }

  const sym = getCurrencySymbol(options?.currency);

  if (unit === "units") {
    return sign + sym + abs.toLocaleString("en-US", { maximumFractionDigits: p });
  }
  // Keep the raw scalar, append suffix. Big ints lose trailing ".0".
  const body =
    abs >= 100 ? abs.toFixed(0)
    : abs >= 10 ? abs.toFixed(Math.min(p, 1))
    : abs.toFixed(p);
  return sign + sym + body + DISPLAY_UNIT_SUFFIX[unit];
}

/**
 * Last-resort guess of the display unit from a raw (actual-dollars) magnitude.
 * Explicit unit always wins; callers should only fall through to this when
 * the producer omitted a unit entirely. Returns "M" for null/NaN so chart
 * axes stay stable rather than flipping between scales on an unloaded series.
 */
export function inferUnitFromMagnitude(
  value: number | null | undefined,
): DisplayUnit {
  if (value === null || value === undefined) return "M";
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return "M";
  if (n >= 1_000_000_000) return "B";
  if (n >= 1_000_000) return "M";
  if (n >= 1_000) return "K";
  return "units";
}

/**
 * Convert any unit-scaled value to actual dollars.
 * Used by `formatFinancialValue` and any caller that needs raw magnitude.
 */
export type UnitScale = "MILLIONS" | "THOUSANDS" | "ACTUALS" | "BILLIONS";

const UNIT_SCALE_MULTIPLIER: Record<UnitScale, number> = {
  ACTUALS: 1,
  THOUSANDS: 1_000,
  MILLIONS: 1_000_000,
  BILLIONS: 1_000_000_000,
};

/**
 * Convert a stored value at the given `unitScale` into actual dollars.
 * Returns `null` when the input is null/undefined/NaN, so callers can
 * pass the result directly to chart datasets without further guarding.
 */
export function toActualDollars(
  value: number | null | undefined,
  unitScale?: UnitScale | null,
): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n * (UNIT_SCALE_MULTIPLIER[unitScale ?? "ACTUALS"] ?? 1);
}

/**
 * Format a financial value stored at any scale at the most appropriate
 * human-readable magnitude. The stored value is converted to "actual"
 * units via `unitScale`, then auto-rendered as B / M / K / raw.
 *
 *   formatFinancialValue(0.0067, "MILLIONS")  -> "$6.7K"
 *   formatFinancialValue(6700, "ACTUALS")     -> "$6.7K"
 *   formatFinancialValue(53.7, "THOUSANDS")   -> "$53.7K"
 *   formatFinancialValue(1.5, "BILLIONS")     -> "$1.5B"
 *   formatFinancialValue(6700)                -> "$6.7K"   // ACTUALS default
 *   formatFinancialValue(null)                -> "\u2014"
 *
 * Notes:
 *   - INR keeps its own Crore/Lakh scale via `formatCurrency` semantics
 *     (the caller can pass currency: "INR"). For INR we render Cr/L instead
 *     of B/M/K, mirroring the existing `formatCurrency` convention.
 *   - `precision` defaults to 1 decimal for K/M/B and 0 for raw < 1000.
 */
export function formatFinancialValue(
  value: number | null | undefined,
  unitScale?: UnitScale | null,
  options?: { currency?: string | null; precision?: number },
): string {
  if (value === null || value === undefined) return "\u2014";
  const n = Number(value);
  if (!Number.isFinite(n)) return "\u2014";

  const scale = unitScale ?? "ACTUALS";
  const mult = UNIT_SCALE_MULTIPLIER[scale] ?? 1;
  const actual = n * mult;
  const sign = actual < 0 ? "-" : "";
  const absActual = Math.abs(actual);

  const sym = getCurrencySymbol(options?.currency);
  const code = (options?.currency || "USD").toUpperCase();
  const userPrecision = options?.precision;

  // INR \u2014 Crore/Lakh system. 1 Cr = 10,000,000; 1 L = 100,000.
  if (code === "INR") {
    const p = userPrecision ?? 1;
    if (absActual >= 10_000_000) {
      return sign + sym + (absActual / 10_000_000).toFixed(p) + "Cr";
    }
    if (absActual >= 100_000) {
      return sign + sym + (absActual / 100_000).toFixed(p) + "L";
    }
    if (absActual >= 1_000) {
      return sign + sym + (absActual / 1_000).toFixed(p) + "K";
    }
    return (
      sign +
      sym +
      absActual.toLocaleString("en-IN", {
        maximumFractionDigits: userPrecision ?? 0,
      })
    );
  }

  // Default scale (USD/EUR/GBP/etc): B / M / K / raw.
  const p = userPrecision ?? 1;
  if (absActual >= 1_000_000_000) {
    return sign + sym + (absActual / 1_000_000_000).toFixed(p) + "B";
  }
  if (absActual >= 1_000_000) {
    return sign + sym + (absActual / 1_000_000).toFixed(p) + "M";
  }
  if (absActual >= 1_000) {
    return sign + sym + (absActual / 1_000).toFixed(p) + "K";
  }
  // Below 1,000: render raw with no scale suffix.
  return (
    sign +
    sym +
    absActual.toLocaleString("en-US", {
      maximumFractionDigits: userPrecision ?? 0,
    })
  );
}

// ---------------------------------------------------------------------------
// Headline metric precedence helpers
// ---------------------------------------------------------------------------
// The deal record has TWO sets of revenue/EBITDA fields:
//   1. cachedRevenue / cachedEbitda / cachedEbitdaMargin — written by the
//      server-side dealCacheWriteback service. Both rev and ebitda come
//      from the same statement row and are stored in ACTUAL DOLLARS, so
//      the ratio is always scale-correct.
//   2. revenue / ebitda — legacy columns. No unitScale tag; ingest paths
//      disagree, so revenue can be in MILLIONS and ebitda in THOUSANDS for
//      the same deal. Computing a margin from these mismatched legacies
//      produced 11103% in production.
// FinancialSummary (per-deal latest INCOME_STATEMENT row) sits between as
// a fallback when the cache hasn't been populated yet.

interface DealLikeMetrics {
  revenue?: number | null;
  ebitda?: number | null;
  currency?: string | null;
  cachedRevenue?: number | null;
  cachedEbitda?: number | null;
  cachedEbitdaMargin?: number | null;
  cachedCurrency?: string | null;
  cachedPeriod?: string | null;
}

interface SummaryLikeMetrics {
  revenue?: number | null;
  ebitda?: number | null;
  ebitdaMargin?: number | null;
  unitScale?: UnitScale | null;
  currency?: string | null;
}

export type HeadlineSource = "cached" | "summary" | "legacy" | "none";

export interface HeadlineMetrics {
  source: HeadlineSource;
  /** Stored revenue value at `unitScale`. */
  revenue: number | null;
  /** Stored EBITDA value at `unitScale`. */
  ebitda: number | null;
  /** Pre-computed EBITDA margin percentage (e.g. 11.1 for 11.1%). */
  ebitdaMargin: number | null;
  /** Unit scale of `revenue` and `ebitda`. ACTUALS for cached, summary's own scale otherwise. */
  unitScale: UnitScale;
  /** Currency code (USD, EUR, …). */
  currency: string | null;
}

/**
 * Resolve revenue / EBITDA / margin for a deal headline using the
 * canonical precedence:
 *
 *   1. Server-cached fields (`cachedRevenue` etc) — ACTUAL DOLLARS,
 *      already self-consistent. `cachedEbitdaMargin` is a precomputed
 *      percentage.
 *   2. The latest income-statement summary, when supplied.
 *   3. The legacy `deal.revenue` / `deal.ebitda` columns, assumed to be
 *      in MILLIONS (matches `formatCurrency`'s convention).
 *
 * Never compute margin from cached rev/ebitda yourself — `cachedEbitdaMargin`
 * is the server's authoritative number. For the legacy fallback we compute
 * `(ebitda / revenue) * 100` from values that share an assumed scale.
 */

/** Reject margins outside [-100, 1000]% — a margin that extreme is almost
 * always a sign that two source fields were written at mismatched scales
 * (the historical 11103% display bug from MILLIONS-vs-THOUSANDS legacy
 * columns). Returns the margin if sane, otherwise null. Also rejects
 * non-finite numbers so NaN/Infinity from `0 / 0` style arithmetic at the
 * call site doesn't slip through. */
function sanitizeMargin(n: number | null | undefined): number | null {
  if (n == null) return null;
  if (!Number.isFinite(n)) return null;
  if (n < -100 || n > 1000) return null;
  return n;
}

/** Compute a margin from legacy deal-level rev/ebitda, suppressing values
 * outside the sanity range via `sanitizeMargin`. */
function legacyMargin(deal: DealLikeMetrics | null | undefined): number | null {
  if (!deal) return null;
  const { revenue: rev, ebitda: ebd } = deal;
  if (rev == null || ebd == null || rev === 0) return null;
  return sanitizeMargin((ebd / rev) * 100);
}

export function pickHeadlineMetrics(
  deal: DealLikeMetrics | null | undefined,
  summary?: SummaryLikeMetrics | null,
): HeadlineMetrics {
  // 1. Cache hit — at least one of revenue/EBITDA/margin populated.
  if (
    deal &&
    (deal.cachedRevenue != null ||
      deal.cachedEbitda != null ||
      deal.cachedEbitdaMargin != null)
  ) {
    return {
      source: "cached",
      revenue: deal.cachedRevenue ?? null,
      ebitda: deal.cachedEbitda ?? null,
      ebitdaMargin: deal.cachedEbitdaMargin ?? null,
      unitScale: "ACTUALS",
      currency: deal.cachedCurrency ?? deal.currency ?? null,
    };
  }

  // 2. FinancialStatement summary fallback.
  if (summary && (summary.revenue != null || summary.ebitda != null)) {
    const rev = summary.revenue ?? null;
    const ebd = summary.ebitda ?? null;
    // Try each source in precedence order, sanitizing every candidate so a
    // mismatched-scale extraction (e.g. revenue MILLIONS / ebitda
    // THOUSANDS on the same row) can't render as 11103%. Each source can
    // independently fall through to the next when out of sanity range.
    //   1. summary.ebitdaMargin (server-extracted)
    //   2. (ebd / rev) * 100 from the same summary row
    //   3. legacyMargin(deal) — supplements when the picked summary row
    //      has revenue but no EBITDA (common for monthly rows where EBITDA
    //      is computed only at the year level)
    let margin = sanitizeMargin(summary.ebitdaMargin ?? null);
    if (margin == null && rev != null && ebd != null && rev !== 0) {
      margin = sanitizeMargin((ebd / rev) * 100);
    }
    if (margin == null) margin = legacyMargin(deal);
    return {
      source: "summary",
      revenue: rev,
      ebitda: ebd,
      ebitdaMargin: margin,
      unitScale: summary.unitScale ?? "ACTUALS",
      currency: summary.currency ?? deal?.currency ?? null,
    };
  }

  // 3. Legacy deal-level columns (assumed MILLIONS). Mismatched across
  // ingest paths — last resort only.
  if (deal && (deal.revenue != null || deal.ebitda != null)) {
    const rev = deal.revenue ?? null;
    const ebd = deal.ebitda ?? null;
    return {
      source: "legacy",
      revenue: rev,
      ebitda: ebd,
      ebitdaMargin: legacyMargin(deal),
      unitScale: "MILLIONS",
      currency: deal?.currency ?? null,
    };
  }

  return {
    source: "none",
    revenue: null,
    ebitda: null,
    ebitdaMargin: null,
    unitScale: "ACTUALS",
    currency: deal?.currency ?? null,
  };
}

/** Format a HeadlineMetrics value at its native scale + currency. */
export function formatHeadlineValue(
  value: number | null | undefined,
  metrics: HeadlineMetrics,
): string {
  if (value == null) return "—";
  if (metrics.source === "legacy") {
    // Legacy columns are MILLIONS — use the legacy formatter (which
    // assumes MILLIONS) to preserve historical display semantics.
    return formatCurrency(value, metrics.currency);
  }
  return formatFinancialValue(value, metrics.unitScale, {
    currency: metrics.currency,
  });
}

/**
 * Format a unitless ratio/percentage. Use this for fields like
 * `ebitda_margin_pct`, `gross_margin_pct`, growth rates, etc.
 *
 *   formatPercent(12.345)   -> "12.3%"
 *   formatPercent(null)     -> "\u2014"
 */
export function formatPercent(
  value: number | null | undefined,
  decimals = 1,
): string {
  if (value === null || value === undefined) return "\u2014";
  const n = Number(value);
  if (!Number.isFinite(n)) return "\u2014";
  return n.toFixed(decimals) + "%";
}

export function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return "\u2014";
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 30) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  }
  if (days > 0) return days + (days === 1 ? " day ago" : " days ago");
  if (hours > 0) return hours + (hours === 1 ? " hour ago" : " hours ago");
  if (minutes > 0) return minutes + (minutes === 1 ? " min ago" : " mins ago");
  return "Just now";
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "\u2014";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

export function getDocIcon(name: string | null | undefined): string {
  if (!name) return "description";
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "picture_as_pdf";
  if (ext === "xlsx" || ext === "xls") return "table_chart";
  if (ext === "csv") return "table_view";
  if (ext === "msg" || ext === "eml") return "mail";
  if (ext === "docx" || ext === "doc") return "article";
  if (ext === "md") return "summarize";
  if (name.startsWith("Deal Overview")) return "summarize";
  return "description";
}

/**
 * Resolve the best display name for a deal.
 *
 * Priority: companyName > company.name > name (cleaned).
 * If the final value looks like a URL, extract a readable domain name from it
 * (e.g. "https://www.backlift.com/about" -> "Backlift").
 */
export function getDealDisplayName(deal: {
  name: string;
  companyName?: string | null;
  company?: { name?: string | null } | null;
}): string {
  const raw = deal.companyName || deal.company?.name || deal.name;
  return cleanNameIfUrl(raw);
}

/** If `value` looks like a URL, extract a human-readable domain name from it. */
function cleanNameIfUrl(value: string): string {
  if (!value) return value;
  // Quick check: does it start with http(s):// or www. ?
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed) && !/^www\./i.test(trimmed)) {
    return value;
  }
  try {
    const urlStr = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
    const hostname = new URL(urlStr).hostname;
    // Strip "www." prefix
    const domain = hostname.replace(/^www\./i, "");
    // Take the main part before the TLD (e.g. "backlift.com" -> "backlift")
    const parts = domain.split(".");
    const name = parts.length > 1 ? parts.slice(0, -1).join(".") : domain;
    // Capitalize first letter of each segment
    return name
      .split(/[.\-_]/)
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join(" ");
  } catch (err) {
    // Not a valid URL despite looking like one — return as-is.
    console.warn("[formatters] derivedNameFromUrl failed:", err);
    return value;
  }
}

/** Extract initials from a name or firstName+lastName. Max 2 chars, uppercased. */
export function getInitials(nameOrFirst?: string | null, lastName?: string): string {
  if (lastName !== undefined) {
    // Two-arg form: getInitials("John", "Doe") → "JD"
    const f = (nameOrFirst || "")[0] || "";
    const l = (lastName || "")[0] || "";
    return (f + l).toUpperCase() || "?";
  }
  // Single-arg form: getInitials("John Doe") → "JD"
  if (!nameOrFirst) return "?";
  return nameOrFirst.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "?";
}
