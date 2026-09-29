// The deal pipeline's stages, in order. Must match web-next's STAGES
// (apps/web-next/src/lib/constants.ts): a deal saved with any other value is
// stored but never shown in a pipeline column.
export const DEAL_STAGES = [
  'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED', 'LOI_SUBMITTED',
  'NEGOTIATION', 'CLOSING', 'PASSED', 'CLOSED_WON', 'CLOSED_LOST',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];
