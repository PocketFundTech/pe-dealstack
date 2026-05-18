import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { runFirmResearch, runDeepResearch } from '../services/agents/firmResearchAgent/index.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { extractNameFromDomain } from '../utils/urlHelpers.js';
import { runWithUsageContext } from '../middleware/usageContext.js';
import firmProfileRouter from './onboarding-firm.js';

const router = Router();

// Sub-routers
router.use('/', firmProfileRouter);

const VALID_STEPS = ['createDeal', 'uploadDocument', 'reviewExtraction', 'tryDealChat', 'inviteTeamMember'];

const DEFAULT_STATUS = {
  welcomeShown: false,
  checklistDismissed: false,
  steps: {
    createDeal: false,
    uploadDocument: false,
    reviewExtraction: false,
    tryDealChat: false,
    inviteTeamMember: false,
  },
};

// Check if THIS user is genuinely new (has no audit-log activity of their own).
// Org-scoped checks were wrong: a fresh invitee joining a populated org, or
// any signup into an org that already had demo deals, would be classified as
// "existing" and silently bypass onboarding. AuditLog.userId is the
// per-actor signal — pre-existing users have entries, fresh users don't.
async function isNewUser(userId: string, _orgId: string): Promise<boolean> {
  const { count } = await supabase
    .from('AuditLog')
    .select('id', { count: 'exact', head: true })
    .eq('userId', userId);
  return (count ?? 0) === 0;
}

// Auto-mark existing users as onboarded (they don't need the flow)
const COMPLETED_STATUS = {
  welcomeShown: true,
  checklistDismissed: true,
  completedAt: new Date().toISOString(),
  steps: {
    createDeal: true,
    uploadDocument: true,
    reviewExtraction: true,
    tryDealChat: true,
    inviteTeamMember: true,
  },
};

/**
 * Fire-and-forget helper to mark an onboarding step complete.
 * Used by other routes (documents, invitations) to auto-detect steps.
 * Never throws — onboarding must never block core functionality.
 */
export async function tryCompleteOnboardingStep(userId: string, step: string): Promise<void> {
  try {
    if (!VALID_STEPS.includes(step)) return;

    const { data: user } = await supabase
      .from('User')
      .select('onboardingStatus')
      .eq('authId', userId)
      .single();

    const status = user?.onboardingStatus || { ...DEFAULT_STATUS };
    if (!status.steps) status.steps = { ...DEFAULT_STATUS.steps };
    if (status.steps[step]) return; // Already complete

    status.steps[step] = true;

    const allComplete = VALID_STEPS.every(s => status.steps[s]);
    if (allComplete && !status.completedAt) {
      status.completedAt = new Date().toISOString();
    }

    await supabase
      .from('User')
      .update({ onboardingStatus: status })
      .eq('authId', userId);
  } catch (e) {
    // Silent — never block core routes
  }
}

/**
 * Backfill onboarding steps from THIS user's audit-log activity.
 * Org-scoped queries were silently auto-completing onboarding for fresh
 * invitees (any deal in the org → step ticked). Audit-log filtered by
 * userId is the only signal that distinguishes the actor from the org.
 */
async function backfillStepsFromActivity(userId: string, status: any): Promise<{ status: any; changed: boolean }> {
  if (!status.steps) status.steps = { ...DEFAULT_STATUS.steps };
  let changed = false;

  const checks: Array<{ step: string; actions: string[] }> = [
    { step: 'createDeal',       actions: ['DEAL_CREATED'] },
    { step: 'uploadDocument',   actions: ['DOCUMENT_UPLOADED'] },
    { step: 'tryDealChat',      actions: ['AI_CHAT'] },
    { step: 'inviteTeamMember', actions: ['INVITATION_SENT'] },
    // reviewExtraction has no clean audit-log signal; left to explicit
    // complete-step calls or stays false.
  ];

  for (const { step, actions } of checks) {
    if (status.steps[step]) continue;
    try {
      const { count } = await supabase
        .from('AuditLog')
        .select('id', { count: 'exact', head: true })
        .eq('userId', userId)
        .in('action', actions);
      if ((count ?? 0) > 0) {
        status.steps[step] = true;
        changed = true;
      }
    } catch (err) {
      // Best-effort — never block status fetch
      log.warn('onboarding: audit-log backfill check failed', { step, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (changed) {
    const allComplete = VALID_STEPS.every(s => status.steps[s]);
    if (allComplete && !status.completedAt) {
      status.completedAt = new Date().toISOString();
    }
  }

  return { status, changed };
}

// GET /api/onboarding/status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json(DEFAULT_STATUS);
    const orgId = getOrgId(req);
    const { data, error } = await supabase
      .from('User')
      .select('onboardingStatus')
      .eq('authId', userId)
      .single();

    if (error) throw error;

    let status = data?.onboardingStatus || { ...DEFAULT_STATUS };

    // If welcome hasn't been shown yet, check if this is really a new user
    // Existing users with deals/activity should skip onboarding entirely
    if (!status.welcomeShown) {
      const newUser = await isNewUser(userId, orgId);
      if (!newUser) {
        // Auto-complete onboarding for existing users
        await supabase
          .from('User')
          .update({ onboardingStatus: COMPLETED_STATUS })
          .eq('authId', userId);
        return res.json(COMPLETED_STATUS);
      }
    }

    // Backfill any steps the user has actually completed via activity
    // (handles missed hook fires + manual check-off persistence)
    if (!status.checklistDismissed) {
      const { status: updated, changed } = await backfillStepsFromActivity(userId, status);
      if (changed) {
        status = updated;
        await supabase
          .from('User')
          .update({ onboardingStatus: status })
          .eq('authId', userId);
      }
    }

    res.json(status);
  } catch (error: any) {
    console.error('[Onboarding] Failed to get status:', error.message);
    res.json(DEFAULT_STATUS);
  }
});

// POST /api/onboarding/complete-step
router.post('/complete-step', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { step } = req.body;

    if (!step || !VALID_STEPS.includes(step)) {
      return res.status(400).json({ error: `Invalid step. Must be one of: ${VALID_STEPS.join(', ')}` });
    }

    // Get current status
    const { data: user, error: fetchError } = await supabase
      .from('User')
      .select('onboardingStatus')
      .eq('authId', userId)
      .single();

    if (fetchError) throw fetchError;

    const status = user?.onboardingStatus || { ...DEFAULT_STATUS };
    if (!status.steps) status.steps = { ...DEFAULT_STATUS.steps };
    status.steps[step] = true;

    // Check if all steps are complete
    const allComplete = VALID_STEPS.every(s => status.steps[s]);
    if (allComplete && !status.completedAt) {
      status.completedAt = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from('User')
      .update({ onboardingStatus: status })
      .eq('authId', userId);

    if (updateError) throw updateError;

    res.json({ success: true, status });
  } catch (error: any) {
    console.error('[Onboarding] Failed to complete step:', error.message);
    res.status(500).json({ error: 'Failed to update onboarding status' });
  }
});

// POST /api/onboarding/welcome-shown
router.post('/welcome-shown', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    const { data: user } = await supabase
      .from('User')
      .select('onboardingStatus')
      .eq('authId', userId)
      .single();

    const status = user?.onboardingStatus || { ...DEFAULT_STATUS };
    status.welcomeShown = true;

    await supabase
      .from('User')
      .update({ onboardingStatus: status })
      .eq('authId', userId);

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Onboarding] Failed to mark welcome shown:', error.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /api/onboarding/dismiss
router.post('/dismiss', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    const { data: user } = await supabase
      .from('User')
      .select('onboardingStatus')
      .eq('authId', userId)
      .single();

    const status = user?.onboardingStatus || { ...DEFAULT_STATUS };
    status.checklistDismissed = true;

    await supabase
      .from('User')
      .update({ onboardingStatus: status })
      .eq('authId', userId);

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Onboarding] Failed to dismiss:', error.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /api/onboarding/enrich-firm
// Runs firm research agent → scrapes, searches, synthesizes, verifies, saves
router.post('/enrich-firm', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { websiteUrl, linkedinUrl } = req.body;
    if (!websiteUrl && !linkedinUrl) {
      return res.status(400).json({ error: 'Provide at least a websiteUrl or linkedinUrl' });
    }

    // Try to resolve org — but don't block if it's not available yet (new users)
    let orgId: string = '';
    let firmName = '';
    try {
      orgId = req.user?.organizationId || '';
      if (!orgId) {
        const { data: userData } = await supabase
          .from('User')
          .select('organizationId')
          .eq('authId', userId)
          .single();
        orgId = userData?.organizationId || '';
      }
      if (orgId) {
        const { data: org } = await supabase
          .from('Organization')
          .select('id, name, website, settings')
          .eq('id', orgId)
          .single();
        firmName = org?.name || '';

        // Rate limit check (only if org exists)
        const settings = (org?.settings || {}) as Record<string, any>;
        const history = settings.enrichmentHistory || [];
        const oneHourAgo = Date.now() - 3600000;
        const recentRuns = history.filter((h: any) => new Date(h.timestamp).getTime() > oneHourAgo);
        if (recentRuns.length >= 3) {
          return res.status(429).json({ error: 'Max 3 enrichment runs per hour. Try again later.' });
        }
      }
    } catch (err) {
      // Org not available yet — agent will still scrape and search, just won't save to org
      log.warn('Enrichment: org not available, running without save', { userId, error: err instanceof Error ? err.message : String(err) });
    }

    // Extract firm name from website URL as fallback
    if (!firmName && websiteUrl) {
      firmName = extractNameFromDomain(websiteUrl) || '';
    }

    // Run the research agent — works even without org (just won't save to DB)
    const result = await runFirmResearch({
      websiteUrl: websiteUrl || '',
      linkedinUrl: linkedinUrl || '',
      firmName,
      userId,
      organizationId: orgId,
    });

    log.info('Firm enrichment complete', { orgId: orgId || 'none', success: result.success, confidence: result.firmProfile?.confidence });

    res.json(result);

    // Fire Phase 2 deep research in background (not awaited).
    // We wrap in runWithUsageContext so every LLM call inside the background
    // task is attributed to the correct user/org — AsyncLocalStorage is lost
    // once the HTTP response has been sent.
    if (result.success && result.firmProfile && (websiteUrl || linkedinUrl)) {
      void runWithUsageContext(
        { userId, organizationId: orgId, source: 'background' },
        async () => {
          await runDeepResearch({
            phase1Profile: result.firmProfile!,
            phase1PersonProfile: result.personProfile,
            websiteUrl: websiteUrl || '',
            linkedinUrl: linkedinUrl || '',
            firmName,
            userId,
            organizationId: orgId,
          }).catch(err => {
            log.error('Deep research background task failed', { error: err.message });
            captureAgentError(err, { context: 'runDeepResearch:background' });
          });
        },
      );
    }
  } catch (error: any) {
    log.error('Firm enrichment endpoint failed', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: `Enrichment failed: ${error.message}` });
  }
});

// GET /api/onboarding/research-status
// Polled by frontend to check Phase 2 deep research progress
router.get('/research-status', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ phase: 1, status: 'complete', newInsightsCount: 0 });

    let orgId: string = req.user?.organizationId || '';
    if (!orgId) {
      const { data: userData } = await supabase
        .from('User')
        .select('organizationId')
        .eq('authId', userId)
        .single();
      orgId = userData?.organizationId || '';
    }
    if (!orgId) {
      return res.json({ phase: 1, status: 'complete', newInsightsCount: 0 });
    }

    const { data: org } = await supabase
      .from('Organization')
      .select('settings')
      .eq('id', orgId)
      .single();

    const settings = (org?.settings || {}) as Record<string, any>;
    const deepResearch = settings.deepResearch;

    if (!deepResearch) {
      return res.json({ phase: 1, status: 'complete', newInsightsCount: 0 });
    }

    res.json({
      phase: 2,
      status: deepResearch.status,
      newInsightsCount: deepResearch.insightsFound || 0,
      completedAt: deepResearch.completedAt || null,
    });
  } catch (error: any) {
    log.error('Research status check failed', { error: error.message });
    res.json({ phase: 1, status: 'complete', newInsightsCount: 0 });
  }
});

// POST /api/onboarding/create-demo-deal
// Creates the Luktara Industries sample deal when user selects it during onboarding
router.post('/create-demo-deal', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { sampleId } = req.body;
    if (sampleId !== 'luktara' && sampleId !== 'pinecrest') {
      return res.status(400).json({ error: 'Invalid sample deal ID' });
    }

    // Resolve org and the User table's internal id. Deal.assignedTo /
    // Folder.createdBy foreign-key to User.id, NOT the Supabase authId
    // — passing req.user.id (the auth UUID) directly would 23503.
    let orgId: string = req.user?.organizationId || '';
    let userInternalId: string | null = null;
    {
      const { data: userData } = await supabase
        .from('User')
        .select('id, organizationId')
        .eq('authId', userId)
        .single();
      if (userData) {
        userInternalId = userData.id;
        if (!orgId) orgId = userData.organizationId || '';
      }
    }
    if (!orgId) {
      return res.status(400).json({ error: 'Organization not set up yet' });
    }
    if (!userInternalId) {
      return res.status(400).json({ error: 'User profile not set up yet' });
    }

    // Check if sample deal already exists (prevent duplicates)
    const { data: existing } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId)
      .contains('tags', ['sample'])
      .limit(1);

    if (existing && existing.length > 0) {
      // Already has a sample deal — return its ID
      return res.json({ success: true, dealId: existing[0].id, alreadyExists: true });
    }

    // Create the sample deal
    const { createSampleDeal } = await import('../services/sampleDealService.js');
    const dealId = await createSampleDeal(orgId, userInternalId);

    if (!dealId) {
      return res.status(500).json({ error: 'Failed to create demo deal' });
    }

    log.info('Demo deal created from onboarding', { orgId, dealId, sampleId });
    res.json({ success: true, dealId });
  } catch (error: any) {
    log.error('Create demo deal failed', { error: error.message });
    res.status(500).json({ error: 'Failed to create demo deal. Please try again.' });
  }
});

export default router;
