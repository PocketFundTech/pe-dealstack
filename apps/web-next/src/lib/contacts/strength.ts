// ─── Relationship-strength tiering ──────────────────────────────────────────
// Single source of truth for turning a contact's relationship score into a
// 3-tier visual pill (strong / warm / cold). The numeric score + richer label
// come from the API endpoint GET /contacts/insights/scores (see
// apps/api/src/routes/contacts-insights.ts), whose thresholds are mirrored here
// so the list pill and the detail panel agree on tiering.
//
// Score buckets in the API (0–100 total): Strong >75, Active >50, Warm >25,
// else Cold. We collapse those four labels into three visual tiers — "Active"
// rolls up into the warm/amber band so the list stays scannable at a glance.

// The shape the scores endpoint returns per contact.
export interface ContactScore {
  score: number;
  label: string;
}

export type StrengthTier = "strong" | "warm" | "cold";

export const STRENGTH_TIER = {
  STRONG: "strong",
  WARM: "warm",
  COLD: "cold",
} as const;

// Thresholds mirror contacts-insights.ts label assignment.
// Strong: >75 (API "Strong"). Warm: >25 (API "Active"/"Warm"). Cold: otherwise.
const STRONG_MIN = 75;
const WARM_MIN = 25;

// Tailwind palette classes per tier — no raw hex. Green = strong, amber = warm,
// gray = cold. `dot` is the small status dot rendered inside the pill.
export const STRENGTH_TIER_STYLE: Record<
  StrengthTier,
  { bg: string; text: string; dot: string; label: string }
> = {
  strong: { bg: "bg-green-100", text: "text-green-800", dot: "bg-green-600", label: "Strong" },
  warm:   { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500", label: "Warm" },
  cold:   { bg: "bg-gray-100",  text: "text-gray-600",  dot: "bg-gray-400",  label: "Cold" },
};

// Sort weight so "strong" ranks above "warm" above "cold". Used by the list
// comparator; higher = stronger relationship.
const TIER_WEIGHT: Record<StrengthTier, number> = { strong: 3, warm: 2, cold: 1 };

// Maps a raw numeric score to one of the three visual tiers.
export function strengthTierFromScore(score: number): StrengthTier {
  if (score >= STRONG_MIN) return STRENGTH_TIER.STRONG;
  if (score >= WARM_MIN) return STRENGTH_TIER.WARM;
  return STRENGTH_TIER.COLD;
}

// Resolves a contact's tier from the scores map. Missing/unscored contacts are
// treated as "cold" so the pill always has a defined tier.
export function strengthTierForContact(score: ContactScore | undefined): StrengthTier {
  if (!score) return STRENGTH_TIER.COLD;
  return strengthTierFromScore(score.score);
}

// Human-readable tooltip explaining the tier, including the underlying score
// when known. Drives the pill's `title` attribute.
export function strengthTooltip(score: ContactScore | undefined): string {
  if (!score) return "Relationship strength: not yet scored";
  const tier = STRENGTH_TIER_STYLE[strengthTierFromScore(score.score)].label;
  return `Relationship strength: ${tier} (${score.score}/100, ${score.label})`;
}

// Comparator for sorting contacts by relationship strength, strongest first.
// Ties (same tier) fall back to the raw score, then are stable. Pass the same
// `scores` map the list already loads from /contacts/insights/scores.
//
// NOTE: strength is a client-derived value the list API can't sort on (its
// sortBy enum is name|company|lastContactedAt|createdAt), so sorting must run
// client-side over the already-loaded page using this comparator.
export function compareByStrength(
  scores: Record<string, ContactScore | undefined>,
  order: "asc" | "desc" = "desc",
) {
  return (a: { id: string }, b: { id: string }): number => {
    const sa = scores[a.id];
    const sb = scores[b.id];
    const wa = TIER_WEIGHT[strengthTierForContact(sa)];
    const wb = TIER_WEIGHT[strengthTierForContact(sb)];
    let diff = wb - wa; // desc by default (strongest first)
    if (diff === 0) diff = (sb?.score ?? 0) - (sa?.score ?? 0);
    return order === "asc" ? -diff : diff;
  };
}
