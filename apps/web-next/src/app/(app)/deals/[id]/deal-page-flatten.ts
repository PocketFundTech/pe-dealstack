import type { DealDetail } from "./deal-detail-shared";

// GET /deals/:id returns team membership as a nested `teamMembers` join
// (`{ role, user: { id, name, ... } }[]`); the rest of the deal-detail page
// reads a flat `team: TeamMember[]`. This used to happen once, inline, in
// page.tsx's loadDeal(). Now that `/deals/:id` goes through useApiQuery
// (page.tsx), every `setDeal(...)` call site round-trips through this
// flatten step too (see the `setDeal` adapter in page.tsx), so it must be
// idempotent -- safe to apply to data that's already flattened.
export type RawDeal = DealDetail & {
  teamMembers?: Array<{ role: string; user: { id: string; name: string; avatar?: string; email?: string } }>;
};

export function flattenDeal(raw: RawDeal): DealDetail {
  return {
    ...raw,
    team:
      raw.team ||
      raw.teamMembers?.map((tm) => ({
        id: tm.user?.id || "",
        name: tm.user?.name || "",
        avatar: tm.user?.avatar,
        email: tm.user?.email,
        role: tm.role,
      })) ||
      [],
  };
}
