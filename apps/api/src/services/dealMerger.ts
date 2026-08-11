/**
 * Shared Deal Merger Service
 * Merges AI-extracted data into existing deals with confidence-based logic.
 * Used by both ingest.ts and documents.ts upload flows.
 */

import { supabase } from '../supabase.js';
import { ExtractedDealData } from './aiExtractor.js';
import { log } from '../utils/logger.js';
import { refreshDealCache } from './dealCacheWriteback.js';

// Map document type icons
const industryIcons: Record<string, string> = {
  'Healthcare': 'monitor_heart',
  'Healthcare Services': 'monitor_heart',
  'Technology': 'memory',
  'Software': 'code',
  'SaaS': 'cloud',
  'Enterprise Software': 'cloud',
  'Cloud Infrastructure': 'cloud_queue',
  'Manufacturing': 'precision_manufacturing',
  'Industrial Manufacturing': 'precision_manufacturing',
  'Transportation': 'local_shipping',
  'Logistics': 'webhook',
  'Supply Chain': 'webhook',
  'Financial Services': 'account_balance',
  'Retail': 'storefront',
  'E-commerce': 'shopping_cart',
  'Energy': 'bolt',
  'Real Estate': 'home_work',
  'Consumer': 'shopping_bag',
  'Food & Beverage': 'restaurant',
  'Education': 'school',
};

export function getIconForIndustry(industry: string | null): string {
  if (!industry) return 'business_center';

  // Check for exact match first
  if (industryIcons[industry]) return industryIcons[industry];

  // Check for partial match
  const lowerIndustry = industry.toLowerCase();
  for (const [key, icon] of Object.entries(industryIcons)) {
    if (lowerIndustry.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerIndustry)) {
      return icon;
    }
  }

  return 'business_center';
}

/**
 * Per-field confidence floor. Financial fields below this confidence are NOT
 * auto-merged into the Deal table — they're surfaced via aiData.reviewReasons
 * but the existing deal.revenue / deal.dealSize values are preserved. This
 * prevents low-confidence extractions from a one-pager teaser from silently
 * overwriting correct figures from a CIM or financial model.
 */
const FIELD_AUTOMERGE_CONFIDENCE_FLOOR = 60;

/**
 * Merge AI-extracted data into an existing deal.
 * Updates financial fields only when:
 *   - existing value is null, OR
 *   - new extraction has higher confidence than the deal's stored confidence
 * AND the new extraction's per-field confidence clears FIELD_AUTOMERGE_CONFIDENCE_FLOOR.
 * Low-confidence values are deliberately preserved-as-pending (still recorded
 * in the Document.extractedData JSON, but not promoted to deal.X).
 * Returns the updated deal.
 */
export async function mergeIntoExistingDeal(
  dealId: string,
  aiData: ExtractedDealData,
  userId: string | undefined,
  sourceName: string,
): Promise<{ deal: any; isNew: false }> {
  // Fetch existing deal
  const { data: existingDeal, error: fetchErr } = await supabase
    .from('Deal')
    .select('*, company:Company(*)')
    .eq('id', dealId)
    .single();

  if (fetchErr || !existingDeal) {
    throw new Error('Deal not found');
  }

  // Build update object — only override fields where new data is better
  const updates: Record<string, any> = {
    lastDocument: sourceName,
    lastDocumentUpdated: new Date().toISOString(),
  };

  const existingConf = existingDeal.extractionConfidence || 0;
  const skippedLowConfidence: string[] = [];

  // Merge each financial field: update if existing is null or new confidence
  // is higher AND per-field confidence clears the floor. Low-confidence
  // financial values are left as pending — they won't overwrite correct
  // numbers stored on the Deal from a higher-quality source.
  if (aiData.revenue.value != null && (existingDeal.revenue == null || aiData.revenue.confidence > existingConf)) {
    if (aiData.revenue.confidence >= FIELD_AUTOMERGE_CONFIDENCE_FLOOR) {
      updates.revenue = aiData.revenue.value;
    } else {
      skippedLowConfidence.push(`revenue (${aiData.revenue.confidence}%)`);
    }
  }
  // Defensive units-mismatch guard: when both revenue and ebitda are being
  // written fresh (existing.revenue is null), reject ebitda values that imply
  // an EBITDA/revenue ratio above 50×. A real EBITDA margin lives in the
  // -50%..+50% range — never 50× revenue. A ratio that high almost always
  // indicates the LLM returned ebitda in a different unit (raw dollars or
  // thousands) than revenue. Skipping the write here prevents a
  // 1000×-wrong value from polluting every downstream view.
  const ebitdaUnitsMismatch =
    aiData.revenue.value != null &&
    aiData.ebitda.value != null &&
    existingDeal.revenue == null &&
    Math.abs(aiData.revenue.value) > 0 &&
    Math.abs(aiData.ebitda.value / aiData.revenue.value) > 50;

  if (ebitdaUnitsMismatch) {
    const r = aiData.revenue.value as number;
    const e = aiData.ebitda.value as number;
    const ratio = e / r;
    log.warn('Deal merge: ebitda units mismatch suspected, skipping ebitda write', {
      dealId,
      sourceName,
      revenue: r,
      ebitda: e,
      ratio,
    });
    skippedLowConfidence.push(
      `ebitda (${aiData.ebitda.confidence}%, units mismatch: ebitda/revenue=${ratio.toFixed(1)}x)`,
    );
  } else if (aiData.ebitda.value != null && (existingDeal.ebitda == null || aiData.ebitda.confidence > existingConf)) {
    if (aiData.ebitda.confidence >= FIELD_AUTOMERGE_CONFIDENCE_FLOOR) {
      updates.ebitda = aiData.ebitda.value;
    } else {
      skippedLowConfidence.push(`ebitda (${aiData.ebitda.confidence}%)`);
    }
  }
  if (aiData.dealSize?.value != null && (existingDeal.dealSize == null || aiData.dealSize.confidence > existingConf)) {
    if (aiData.dealSize.confidence >= FIELD_AUTOMERGE_CONFIDENCE_FLOOR) {
      updates.dealSize = aiData.dealSize.value;
    } else {
      skippedLowConfidence.push(`dealSize (${aiData.dealSize.confidence}%)`);
    }
  }
  if (aiData.industry.value && (!existingDeal.industry || aiData.industry.confidence > existingConf)) {
    updates.industry = aiData.industry.value;
    updates.icon = getIconForIndustry(aiData.industry.value);
  }
  if (aiData.description.value && aiData.description.value !== 'No description available' && (!existingDeal.description || aiData.description.confidence > existingConf)) {
    updates.description = aiData.description.value;
  }
  if (aiData.summary && (!existingDeal.aiThesis || aiData.overallConfidence > existingConf)) {
    updates.aiThesis = aiData.summary;
  }

  if (skippedLowConfidence.length > 0) {
    log.info('Deal merge: skipped low-confidence fields', {
      dealId,
      sourceName,
      skipped: skippedLowConfidence,
      floor: FIELD_AUTOMERGE_CONFIDENCE_FLOOR,
    });
  }

  // Merge risks/highlights (append new unique items)
  const existingRisks = existingDeal.aiRisks || { keyRisks: [], investmentHighlights: [] };
  const mergedKeyRisks = [...new Set([...(existingRisks.keyRisks || []), ...(aiData.keyRisks || [])])];
  const mergedHighlights = [...new Set([...(existingRisks.investmentHighlights || []), ...(aiData.investmentHighlights || [])])];
  updates.aiRisks = { keyRisks: mergedKeyRisks, investmentHighlights: mergedHighlights };

  // Update confidence to the higher of old vs new
  if (aiData.overallConfidence > existingConf) {
    updates.extractionConfidence = aiData.overallConfidence;
  }

  // Clear needsReview only if new extraction is confident AND we didn't skip
  // any fields for low confidence. Otherwise the deal still has unmerged
  // pending data and shouldn't lose its review flag.
  if (!aiData.needsReview && skippedLowConfidence.length === 0 && existingDeal.needsReview) {
    updates.needsReview = false;
    updates.reviewReasons = [];
    updates.status = 'ACTIVE';
  } else if (aiData.needsReview && !existingDeal.needsReview) {
    // Mark for review if new extraction flagged issues, even if existing was clean
    updates.needsReview = true;
    updates.reviewReasons = aiData.reviewReasons || [];
  }

  const { data: updatedDeal, error: updateErr } = await supabase
    .from('Deal')
    .update(updates)
    .eq('id', dealId)
    .select('*, company:Company(*)')
    .single();

  if (updateErr) throw updateErr;

  // Refresh cache so legacy Deal.revenue/ebitda updates above don't leave the
  // canonical cached* columns stale for ingest-driven merges.
  await refreshDealCache(dealId);

  // Log activity
  await supabase.from('Activity').insert({
    dealId,
    type: 'DOCUMENT_ADDED',
    title: `New document added: ${sourceName}`,
    description: `Additional data ingested into "${existingDeal.name}" with ${aiData.overallConfidence}% confidence`,
    metadata: {
      sourceName,
      overallConfidence: aiData.overallConfidence,
      fieldsUpdated: Object.keys(updates).filter(k => k !== 'lastDocument' && k !== 'lastDocumentUpdated'),
    },
  });

  return { deal: updatedDeal, isNew: false };
}
