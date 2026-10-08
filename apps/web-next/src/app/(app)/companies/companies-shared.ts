// Shared types + helpers for the Companies page (/companies) and its drawer.
// Data comes from GET /api/companies/list and GET /api/companies/:id/overview.

export type CompanySource = "hubspot" | "avise";

export interface CompanyDealStub {
  id: string;
  name: string | null;
  stage: string | null;
  status: string | null;
}

export interface CompanyListItem {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  hubspotId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  source: CompanySource;
  dealCount: number;
  deals: CompanyDealStub[];
  contactCount: number;
}

export interface CompanyListResponse {
  companies: CompanyListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CompanyOverview {
  company: {
    id: string;
    name: string;
    industry: string | null;
    description: string | null;
    website: string | null;
    hubspotId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    source: CompanySource;
  };
  deals: Array<CompanyDealStub & { updatedAt: string | null }>;
  contacts: Array<{ id: string; firstName: string | null; lastName: string | null; email: string | null; title: string | null }>;
  contactTotal: number;
}

export type HasDealsFilter = "all" | "yes" | "no";
export type SourceFilter = "all" | "hubspot" | "avise";
export type CompanySort = "name-asc" | "name-desc" | "updatedAt-desc" | "updatedAt-asc";

export const COMPANIES_PAGE_SIZE = 25;

export const HAS_DEALS_OPTIONS: { value: HasDealsFilter; label: string }[] = [
  { value: "all", label: "All companies" },
  { value: "yes", label: "Has deals" },
  { value: "no", label: "No deals" },
];

export const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "hubspot", label: "HubSpot" },
  { value: "avise", label: "Avise" },
];

export const SORT_OPTIONS: { value: CompanySort; label: string }[] = [
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "updatedAt-desc", label: "Recently updated" },
  { value: "updatedAt-asc", label: "Least recently updated" },
];

export const SOURCE_LABELS: Record<CompanySource, string> = { hubspot: "HubSpot", avise: "Avise" };

export function buildCompaniesQuery(opts: {
  search: string;
  hasDeals: HasDealsFilter;
  source: SourceFilter;
  sort: CompanySort;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
  if (opts.hasDeals !== "all") params.set("hasDeals", opts.hasDeals);
  if (opts.source !== "all") params.set("source", opts.source);
  const [sortBy, sortOrder] = opts.sort.split("-");
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);
  params.set("limit", String(COMPANIES_PAGE_SIZE));
  params.set("offset", String(opts.page * COMPANIES_PAGE_SIZE));
  return `/companies/list?${params}`;
}

/** A clickable URL for a stored website ("acme.com" → "https://acme.com"), or null. */
export function websiteHref(website: string | null | undefined): string | null {
  const w = (website ?? "").trim();
  if (!w) return null;
  const href = /^https?:\/\//i.test(w) ? w : `https://${w}`;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Display form of a website: host without "www.". */
export function websiteLabel(website: string | null | undefined): string {
  const href = websiteHref(website);
  if (!href) return website ?? "";
  try {
    return new URL(href).host.replace(/^www\./, "");
  } catch {
    return website ?? "";
  }
}
