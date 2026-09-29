/**
 * The pipeline only shows these stages. Deals saved with any other value
 * vanish from the kanban: the Data Room page created deals as "SCREENING",
 * and the deal chat's change-stage tool offered "LOI_NEGOTIATION" (and not
 * LOI_SUBMITTED or NEGOTIATION). Every writer now uses the one list.
 */
import { describe, it, expect } from 'vitest';
import { DEAL_STAGES } from '../src/services/dealStages.js';
import { createDealSchema } from '../src/routes/deals-schemas.js';
import { inputSchema as changeStageInput } from '../src/services/agents/dealChatAgent/tools/changeDealStage.js';

describe('deal stages', () => {
  it('matches the stages the web pipeline renders', () => {
    expect([...DEAL_STAGES]).toEqual([
      'INITIAL_REVIEW', 'DUE_DILIGENCE', 'IOI_SUBMITTED', 'LOI_SUBMITTED',
      'NEGOTIATION', 'CLOSING', 'PASSED', 'CLOSED_WON', 'CLOSED_LOST',
    ]);
  });

  it('the chat change-stage tool accepts every real stage and nothing else', () => {
    for (const stage of DEAL_STAGES) expect(changeStageInput.safeParse({ stage }).success).toBe(true);
    expect(changeStageInput.safeParse({ stage: 'LOI_NEGOTIATION' }).success).toBe(false);
  });

  it('deal create/update rejects unknown stages', () => {
    expect(createDealSchema.safeParse({ name: 'X', stage: 'SCREENING' }).success).toBe(false);
  });
});
