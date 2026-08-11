import type { Contact } from "./components";
import { compareByStrength, type ContactScore } from "@/lib/contacts/strength";

// ─── Constants & helpers shared by contacts/page.tsx ────────────────────────

export const CONTACTS_PAGE_SIZE = 30;

// Sentinel sortBy for the relationship-strength option. Strength is a
// client-derived value (from /contacts/insights/scores) that the list API
// cannot sort on — its sortBy enum is name|company|lastContactedAt|createdAt.
// So this value must NEVER be forwarded to the API; instead, when it's active,
// fetch with a neutral server sort and re-order the loaded page client-side via
// `sortContactsByStrength` below. `isStrengthSort` gates that branch.
export const STRENGTH_SORT_BY = "strength" as const;

export const SORT_OPTIONS = [
  { sortBy: "createdAt", sortOrder: "desc", label: "Newest First" },
  { sortBy: "createdAt", sortOrder: "asc",  label: "Oldest First" },
  { sortBy: "name",      sortOrder: "asc",  label: "Name A-Z" },
  { sortBy: "name",      sortOrder: "desc", label: "Name Z-A" },
  { sortBy: "company",   sortOrder: "asc",  label: "Company A-Z" },
  { sortBy: "lastContactedAt", sortOrder: "desc", label: "Last Contacted" },
  { sortBy: STRENGTH_SORT_BY,  sortOrder: "desc", label: "Strongest First" },
  { sortBy: STRENGTH_SORT_BY,  sortOrder: "asc",  label: "Weakest First" },
];

// True when the active sort is the client-side strength sort.
export function isStrengthSort(sortBy: string): boolean {
  return sortBy === STRENGTH_SORT_BY;
}

// Returns a NEW array of contacts ordered by relationship strength using the
// scores map the list already loads. Strongest first when order is "desc".
// Call this in the page's render-derived state whenever `isStrengthSort` is
// true (the server can't perform this sort).
export function sortContactsByStrength(
  list: Contact[],
  scores: Record<string, ContactScore | undefined>,
  sortOrder: "asc" | "desc",
): Contact[] {
  return [...list].sort(compareByStrength(scores, sortOrder));
}

// Group contacts by company name, with "No Company" as a fallback bucket.
export function groupContacts(list: Contact[]): Record<string, Contact[]> {
  const groups: Record<string, Contact[]> = {};
  for (const c of list) {
    const key = (c.company || "").trim() || "No Company";
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return groups;
}

// Sort the keys of the grouped contacts: "No Company" always at the bottom,
// then by group size descending (matches legacy behavior).
export function sortGroupKeys(grouped: Record<string, Contact[]>): string[] {
  return Object.keys(grouped).sort((a, b) => {
    if (a === "No Company") return 1;
    if (b === "No Company") return -1;
    return grouped[b].length - grouped[a].length;
  });
}
