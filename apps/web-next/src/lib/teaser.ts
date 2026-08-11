// Shared types for the Firm Teaser feature.
//
// A "firm teaser" is a short, internal triage blurb Claude writes for a deal,
// describing how the target fits one of the firm's named investment-criteria
// profiles — and the catch (e.g. "fits your sector + check size, but priced at
// 9x EBITDA vs your usual 6-7x"). A firm can keep several profiles (e.g. one
// per fund/strategy), so each deal can be teased differently per profile.
//
// Storage: the profile config lives in Organization.settings.firmTeaser; the
// generated per-deal teasers live in the DealTeaser table (one row per
// deal x profile). This module is the single source of truth for the shapes
// shared across the web-next UI — keep it in sync with the API service types
// in apps/api/src/services/firmTeaserService.ts.

// ── Firm config (Organization.settings.firmTeaser) ───────────────────────

// One "rec question" row in the sketch — a criterion the firm cares about
// (label = the question, value = the firm's answer/threshold).
export interface TeaserCriterion {
  id: string;
  label: string;
  value: string;
}

// A named criteria set ("Buyout Fund", "Growth", ...). systemPrompt is the
// editable "Type & Gen" instruction block that shapes tone + what to flag.
export interface TeaserProfile {
  id: string;
  name: string;
  systemPrompt: string;
  criteria: TeaserCriterion[];
  // Firm context (uploaded-doc text + pasted notes) grounding the GEN
  // system-prompt authoring. Persisted with the profile, but an authoring
  // input only — it does not affect generated teasers.
  contextText?: string;
  updatedAt: string;
}

export interface FirmTeaserConfig {
  profiles: TeaserProfile[];
}

// ── Generated teaser (DealTeaser rows / API responses) ───────────────────

export type TeaserVerdict = 'fit' | 'partial' | 'miss';

// One criterion's assessment for a deal.
export interface TeaserFit {
  criterion: string;
  verdict: TeaserVerdict;
  note: string;
}

// A persisted teaser for a single deal x profile.
export interface DealTeaser {
  id: string;
  dealId: string;
  profileId: string;
  profileName?: string; // joined from settings for display
  headline: string; // one-sentence blurb for cards
  fits: TeaserFit[]; // criterion-by-criterion breakdown
  stale: boolean; // true when the profile's criteria changed since generation
  model: string;
  generatedAt: string;
}
