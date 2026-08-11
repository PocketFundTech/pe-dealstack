import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { getUsageContext } from '../../middleware/usageContext.js';
import { getModelPrice, computeCostUsd } from './modelPrices.js';
import { getCreditsForOperation } from './operationCredits.js';

export type UsageProvider =
  | 'openai'
  | 'openrouter'
  | 'gemini'
  | 'anthropic'
  | 'apify'
  | 'azure_doc_intelligence';

export type UsageStatus = 'success' | 'error' | 'rate_limited' | 'blocked';

interface RecordUsageEventBase {
  operation: string;
  provider: UsageProvider;
  status: UsageStatus;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/** LLM call: cost is computed from token counts × ModelPrice lookup. */
interface RecordUsageEventLLM extends RecordUsageEventBase {
  model: string;
  promptTokens: number;
  completionTokens: number;
  unitCostUsd?: never;
  units?: never;
}

/** Non-LLM call (Apify, Azure DocIntel): caller supplies the cost directly. */
interface RecordUsageEventNonLLM extends RecordUsageEventBase {
  model?: never;
  promptTokens?: never;
  completionTokens?: never;
  unitCostUsd: number;
  units: number;
}

export type RecordUsageEventInput = RecordUsageEventLLM | RecordUsageEventNonLLM;

/**
 * Insert one UsageEvent row attributing AI consumption to the current
 * request's user + organization. Fire-and-forget — the caller never blocks
 * on the ledger insert and any failure is logged but not thrown.
 *
 * Cost handling:
 * - For LLM calls (model + token counts), cost is computed via ModelPrice.
 *   When the model isn't in the price table, costUsd=0 AND
 *   metadata.priceLookupFailed=true is set so it can be reconciled later.
 * - For non-LLM providers (Apify, Azure DocIntel), the caller passes
 *   unitCostUsd directly and the model lookup is skipped.
 */
export async function recordUsageEvent(input: RecordUsageEventInput): Promise<void> {
  const ctx = getUsageContext();
  if (!ctx) {
    log.warn('recordUsageEvent: no usage context bound, skipping', {
      operation: input.operation,
    });
    return;
  }

  try {
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    let costUsd = 0;
    const extraMetadata: Record<string, unknown> = {};

    if (input.unitCostUsd !== undefined) {
      costUsd = input.unitCostUsd;
    } else if (input.model) {
      const price = await getModelPrice(input.model);
      if (price) {
        costUsd = computeCostUsd(price, promptTokens, completionTokens);
      } else {
        log.warn('recordUsageEvent: unknown model, costUsd=0', { model: input.model });
        extraMetadata.priceLookupFailed = true;
      }
    }

    const credits = await getCreditsForOperation(input.operation);

    const row = {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      operation: input.operation,
      model: input.model ?? null,
      provider: input.provider,
      promptTokens,
      completionTokens,
      totalTokens,
      units: input.units ?? 0,
      costUsd,
      credits,
      status: input.status,
      durationMs: input.durationMs ?? null,
      metadata: { ...(input.metadata ?? {}), ...extraMetadata, requestId: ctx.requestId },
    };

    const { error } = await supabase.from('UsageEvent').insert(row);
    if (error) {
      log.error('recordUsageEvent: insert failed', {
        error,
        message: error.message,
        code: error.code,
        operation: input.operation,
      });
    }

    // Customer-visible AI inference audit trail. One row per successful AI
    // call so admins can see *what AI saw and when* in their audit feed.
    // Skip errors — they're tracked in UsageEvent metadata instead.
    if (input.status === 'success') {
      try {
        const auditMod = await import('../auditLog.js');
        await auditMod.logAuditEvent({
          action: auditMod.AUDIT_ACTIONS.AI_INFERENCE,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          resourceType: auditMod.RESOURCE_TYPES.SETTINGS,
          resourceId: ctx.organizationId,
          description: `AI inference: ${input.operation}`,
          severity: auditMod.SEVERITY.INFO,
          metadata: {
            operation: input.operation,
            model: input.model ?? null,
            provider: input.provider,
            promptTokens,
            completionTokens,
            totalTokens,
            costUsd,
            durationMs: input.durationMs ?? null,
            requestId: ctx.requestId,
          },
        });
      } catch (auditErr) {
        log.warn('recordUsageEvent: AI_INFERENCE audit write failed', {
          err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
    }
  } catch (err) {
    log.error('recordUsageEvent: threw', {
      err: err instanceof Error ? { message: err.message } : err,
      operation: input.operation,
    });
  }
}
