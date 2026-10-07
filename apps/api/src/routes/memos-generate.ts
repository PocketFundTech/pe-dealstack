// ─── Memo regenerate-all-sections route ───────────────────────────
// POST /api/memos/:id/generate-all — re-runs the memo agent for all
// sections of a memo, streaming progress over SSE. Requires the memo
// to have a bound dealId.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { generateAllSectionsStreaming, GeneratedSection } from '../services/agents/memoAgent/index.js';
import { isAnthropicAvailable } from '../services/ai/client.js';
import { classifyAIError } from '../utils/aiErrors.js';
import { GENERATOR_TYPE_TO_DB_TYPE, memoSectionKey } from './memos-schemas.js';

const router = Router();

// Pre-fetch ALL existing sections for this memo in ONE query, classify
// each generated section in-memory, then issue ONE batched insert for new
// rows plus parallel per-row updates for existing rows. Replaces the
// per-section `.single()` existence check that turned a 10-section
// regeneration into 10-20 sequential round-trips.
async function persistGeneratedSections(memoId: string, generated: GeneratedSection[]) {
  const { data: existingRows } = await supabase
    .from('MemoSection')
    .select('id, type, title')
    .eq('memoId', memoId);
  const existingByKey = new Map<string, { id: string }>();
  for (const row of existingRows || []) {
    const key = memoSectionKey(row.type, row.title);
    if (!existingByKey.has(key)) existingByKey.set(key, { id: row.id });
  }

  let completed = 0;
  // PostgrestFilterBuilder is PromiseLike (thenable), not a real Promise.
  const updatePromises: PromiseLike<any>[] = [];
  const toInsert: any[] = [];

  for (const gen of generated) {
    const updateData: any = {
      content: gen.content,
      aiGenerated: gen.aiGenerated,
      aiModel: gen.aiModel,
      updatedAt: new Date().toISOString(),
    };
    if (gen.tableData) updateData.tableData = gen.tableData;
    if (gen.chartConfig) updateData.chartConfig = gen.chartConfig;

    // Look up by the SAME normalized type (+ title, for CUSTOM) that an
    // existing row would have been cloned/inserted with — matching on the
    // raw generator type here is what caused QA 2026-10-06 #16b: every
    // template-cloned section whose type gets remapped (Quality of
    // Earnings, Management Assessment, Operational Deep Dive, Value
    // Creation Plan, Exit Analysis) never matched its existing row, so a
    // second, duplicate row was inserted for it on every "Generate all".
    const normalizedType = GENERATOR_TYPE_TO_DB_TYPE[gen.type] || gen.type;
    const key = memoSectionKey(normalizedType, gen.title);
    const existing = existingByKey.get(key);
    if (existing) {
      updatePromises.push(
        supabase.from('MemoSection').update(updateData).eq('id', existing.id)
      );
    } else {
      toInsert.push({
        memoId, type: normalizedType, title: gen.title,
        sortOrder: (gen as any).sortOrder || completed + 1,
        status: 'DRAFT', ...updateData,
      });
    }
    completed++;
  }

  await Promise.all(updatePromises);
  if (toInsert.length > 0) {
    await supabase.from('MemoSection').insert(toInsert);
  }

  const { data: refreshedSections } = await supabase
    .from('MemoSection')
    .select('*')
    .eq('memoId', memoId)
    .order('sortOrder', { ascending: true });

  return { completed, sections: refreshedSections || [] };
}

// POST /api/memos/:id/generate-all - Regenerate all sections, streamed over SSE
router.post('/:id/generate-all', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: memo } = await supabase
      .from('Memo')
      .select('id, dealId')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (!memo) return res.status(404).json({ error: 'Memo not found' });
    if (!memo.dealId) {
      return res.status(400).json({
        error: "This memo isn't attached to a deal — attach one before generating AI sections. Open the memo and pick a deal from the title bar, or recreate the memo via the Create Memo modal with a deal selected.",
        code: 'MEMO_MISSING_DEAL',
      });
    }
    if (!isAnthropicAvailable()) return res.status(503).json({ error: 'AI service unavailable' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const send = (event: Record<string, unknown>) => {
      // The client may close the connection (tab close, navigation, Cancel)
      // between one write and the next; a write after that throws and would
      // otherwise crash this handler after we've already started persisting
      // sections.
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // connection already gone — nothing to do
      }
    };

    let sawDone = false;
    try {
      for await (const event of generateAllSectionsStreaming(memo.dealId, orgId, undefined, { signal: abortController.signal })) {
        if (event.type === 'section_complete' || event.type === 'section_revised') {
          // Persist each section as it finishes instead of waiting for the
          // whole run to complete — a refresh, error, or the request's time
          // limit used to lose every section that had already been generated.
          await persistGeneratedSections(id, [event.section]);
          send(event);
        } else if (event.type === 'done') {
          sawDone = true;
          const { completed, sections } = await persistGeneratedSections(id, event.sections);
          send({ type: 'done', success: true, completed, total: event.sections.length, sections });
        } else {
          send(event);
        }
      }
      if (!sawDone && !abortController.signal.aborted) {
        send({
          type: 'error',
          message: 'Generation ended before finishing — sections completed so far have been saved.',
        });
      }
    } catch (streamErr: any) {
      log.error('Generate-all streaming failed', streamErr);
      if (!abortController.signal.aborted) {
        send({ type: 'error', message: classifyAIError(streamErr.message || 'Failed to regenerate memo') });
      }
    } finally {
      res.end();
    }
  } catch (error: any) {
    log.error('Generate-all failed', error);
    res.status(500).json({ error: classifyAIError(error.message || 'Failed to regenerate memo') });
  }
});

export default router;
