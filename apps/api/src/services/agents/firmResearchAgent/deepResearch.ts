// apps/api/src/services/agents/firmResearchAgent/deepResearch.ts
// ─── Deep research — Phase 2 orchestrator ────────────────────────
// Public API: runDeepResearch(input) — fire-and-forget background task
// that follows up Phase 1 with targeted web search, snippet aggregation,
// follow-the-thread name expansion, optional URL scraping, LLM synthesis,
// and persistence of new insights to Organization + User settings.
//
// Helpers split out to keep this file under 500 lines:
//   - deepResearchQueries.ts   — generateQueries / extractNewNames
//   - deepResearchSynthesis.ts — synthesizePhase2 / countInsights / schemas
//   - deepResearchProgress.ts  — updateProgress + DeepResearchProgress type

import { FirmProfile, PersonProfile } from './state.js';
import { searchWeb } from '../../webSearch.js';
import { scrapePageText } from '../../companyResearcher.js';
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { isHighValueUrl } from '../../../utils/urlHelpers.js';
import { generateQueries, extractNewNames } from './deepResearchQueries.js';
import { synthesizePhase2, countInsights } from './deepResearchSynthesis.js';
import { updateProgress } from './deepResearchProgress.js';

const PHASE2_TIMEOUT_MS = 120000;
const MAX_FOLLOWUP_QUERIES = 6;
const MAX_URL_SCRAPES = 3;

// ==========================================
// Types
// ==========================================

export interface DeepResearchInput {
  phase1Profile: FirmProfile | null;
  phase1PersonProfile: PersonProfile | null;
  websiteUrl: string;
  linkedinUrl: string;
  firmName: string;
  userId: string;
  organizationId: string;
}

// ==========================================
// Main: runDeepResearch
// ==========================================

export async function runDeepResearch(input: DeepResearchInput): Promise<void> {
  const startedAt = new Date().toISOString();
  let queriesRun = 0;

  // Set initial progress
  await updateProgress(input.organizationId, {
    status: 'running', startedAt, queriesRun: 0, insightsFound: 0,
  });

  const timeoutAt = Date.now() + PHASE2_TIMEOUT_MS;

  try {
    log.info('Deep research Phase 2 started', { firmName: input.firmName });

    // 1. Generate queries from Phase 1 results
    const queries = await generateQueries(input.phase1Profile, input.phase1PersonProfile);
    if (queries.length === 0) {
      log.warn('Deep research: no queries generated');
      await updateProgress(input.organizationId, {
        status: 'complete', startedAt, queriesRun: 0, insightsFound: 0,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    log.info('Deep research: generated queries', { count: queries.length, categories: queries.map(q => q.category) });

    // Build set of known names (to detect new ones)
    const knownNames = new Set<string>();
    if (input.firmName) knownNames.add(input.firmName.toLowerCase());
    if (input.phase1Profile) {
      for (const pc of input.phase1Profile.portfolioCompanies || []) {
        knownNames.add(pc.name.toLowerCase());
      }
    }

    // 2. Execute queries in parallel batches + follow threads
    let allSnippets = '';
    let followUpsUsed = 0;
    const highValueUrls: string[] = [];
    const batchSize = 3;

    for (let i = 0; i < queries.length; i += batchSize) {
      if (Date.now() > timeoutAt) {
        log.warn('Deep research: timeout reached during query execution');
        break;
      }

      const batch = queries.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (q) => {
          try {
            const results = await searchWeb(q.query, 5);
            return { q, results };
          } catch (error) {
            log.warn('Deep research: query failed', { query: q.query, error: (error as Error).message });
            return { q, results: [] as Awaited<ReturnType<typeof searchWeb>> };
          }
        })
      );

      // Process batch results
      for (const { q, results } of batchResults) {
        queriesRun++;

        if (results.length > 0) {
          allSnippets += `\n--- ${q.category.toUpperCase()}: ${q.query} ---\n`;
          for (const r of results) {
            allSnippets += `${r.title}\n${r.snippet}\nURL: ${r.url}\n\n`;
            // Collect high-value URLs for scraping
            if (isHighValueUrl(r.url) && highValueUrls.length < MAX_URL_SCRAPES) {
              highValueUrls.push(r.url);
            }
          }

          // Follow-the-thread: look for new names
          if (followUpsUsed < MAX_FOLLOWUP_QUERIES) {
            const batchText = results.map(r => `${r.title} ${r.snippet}`).join(' ');
            const newNames = extractNewNames(batchText, knownNames);

            for (const name of newNames) {
              if (followUpsUsed >= MAX_FOLLOWUP_QUERIES) break;
              if (Date.now() > timeoutAt) break;

              const followUpQuery = `"${name}" "${input.firmName}"`;
              const followUpResults = await searchWeb(followUpQuery, 3);
              queriesRun++;
              followUpsUsed++;

              if (followUpResults.length > 0) {
                allSnippets += `\n--- FOLLOW-UP: ${followUpQuery} ---\n`;
                for (const r of followUpResults) {
                  allSnippets += `${r.title}\n${r.snippet}\nURL: ${r.url}\n\n`;
                }
                knownNames.add(name.toLowerCase());
              }

              log.info('Deep research: follow-up', { name, results: followUpResults.length });
            }
          }
        }
      }

      // Update progress periodically
      if (queriesRun % 4 === 0) {
        await updateProgress(input.organizationId, {
          status: 'running', startedAt, queriesRun, insightsFound: 0,
        });
      }
    }

    // 3. Scrape high-value URLs
    let scrapedContent = '';
    for (const url of highValueUrls) {
      if (Date.now() > timeoutAt) break;
      try {
        const text = await scrapePageText(url);
        if (text && text.length > 200) {
          scrapedContent += `\n=== ARTICLE: ${url} ===\n${text.slice(0, 3000)}\n`;
        }
      } catch (err) {
        log.warn('Deep research: scrape failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Final synthesis — merge Phase 1 + Phase 2
    const { firm: firmAdditions, person: personAdditions } = await synthesizePhase2(
      allSnippets, scrapedContent, input.phase1Profile, input.phase1PersonProfile,
    );

    const insightsCount = countInsights(firmAdditions, personAdditions);
    log.info('Deep research: synthesis complete', { insightsCount, queriesRun });

    // 5. Merge into existing Organization.settings.firmProfile
    if (input.organizationId) {
      try {
        const { data: org } = await supabase
          .from('Organization')
          .select('settings')
          .eq('id', input.organizationId)
          .single();

        const settings = (org?.settings || {}) as Record<string, any>;
        const existingProfile = settings.firmProfile || {};

        // Merge Phase 2 additions — never overwrite Phase 1 fields
        const mergedProfile: Record<string, any> = { ...existingProfile };
        mergedProfile.socialPresence = firmAdditions.socialPresence;
        mergedProfile.pressArticles = firmAdditions.pressArticles.slice(0, 5);
        mergedProfile.communityMentions = firmAdditions.communityMentions;
        mergedProfile.coInvestors = firmAdditions.coInvestors;
        mergedProfile.competitorFirms = firmAdditions.competitorFirms;
        mergedProfile.deepResearchComplete = true;
        mergedProfile.deepResearchCompletedAt = new Date().toISOString();
        mergedProfile.deepResearchInsightsCount = insightsCount;

        // Enrich arrays (add new items, don't duplicate)
        const existingPortfolioNames = new Set(
          (existingProfile.portfolioCompanies || []).map((c: any) => c.name.toLowerCase())
        );
        for (const pc of firmAdditions.newPortfolioCompanies) {
          if (!existingPortfolioNames.has(pc.name.toLowerCase())) {
            mergedProfile.portfolioCompanies = [...(mergedProfile.portfolioCompanies || []), { ...pc, verified: false }];
          }
        }

        const existingDealTitles = new Set(
          (existingProfile.recentDeals || []).map((d: any) => d.title.toLowerCase())
        );
        for (const deal of firmAdditions.newRecentDeals) {
          if (!existingDealTitles.has(deal.title.toLowerCase())) {
            mergedProfile.recentDeals = [...(mergedProfile.recentDeals || []), deal];
          }
        }

        // Add new sectors without duplicating
        if (firmAdditions.additionalSectors.length > 0) {
          const existingSectors = new Set((mergedProfile.sectors || []).map((s: string) => s.toLowerCase()));
          for (const sector of firmAdditions.additionalSectors) {
            if (!existingSectors.has(sector.toLowerCase())) {
              mergedProfile.sectors = [...(mergedProfile.sectors || []), sector];
            }
          }
        }

        settings.firmProfile = mergedProfile;

        // Merge person profile additions
        // Person profile is stored on User, not Organization — see step 6 below
        settings.deepResearch = {
          status: 'complete',
          startedAt,
          completedAt: new Date().toISOString(),
          queriesRun,
          insightsFound: insightsCount,
        };

        await supabase.from('Organization').update({ settings }).eq('id', input.organizationId);
      } catch (error) {
        log.error('Deep research: failed to save firm profile', { error: (error as Error).message });
        captureAgentError(error, { agent: 'firmResearchAgent', node: 'deepResearch.saveFirm' });
      }
    }

    // 6. Save person profile additions to User
    if (input.userId && (personAdditions.interviews.length > 0 || personAdditions.socialHandles.twitter)) {
      try {
        const { data: user } = await supabase
          .from('User')
          .select('onboardingStatus')
          .eq('authId', input.userId)
          .single();

        const status = (user?.onboardingStatus || {}) as Record<string, any>;
        const existingPerson = status.personProfile || {};
        status.personProfile = {
          ...existingPerson,
          socialHandles: personAdditions.socialHandles,
          interviews: personAdditions.interviews.slice(0, 5),
          publicContent: personAdditions.publicContent.slice(0, 10),
          networkConnections: personAdditions.networkConnections.slice(0, 10),
        };

        await supabase.from('User').update({ onboardingStatus: status }).eq('authId', input.userId);
      } catch (error) {
        log.error('Deep research: failed to save person profile', { error: (error as Error).message });
        captureAgentError(error, { agent: 'firmResearchAgent', node: 'deepResearch.savePerson' });
      }
    }

    log.info('Deep research Phase 2 complete', {
      firmName: input.firmName,
      queriesRun,
      insightsFound: insightsCount,
      duration: `${Date.now() - new Date(startedAt).getTime()}ms`,
    });

  } catch (error) {
    log.error('Deep research Phase 2 failed', { error: (error as Error).message });
    captureAgentError(error, { agent: 'firmResearchAgent', node: 'deepResearch.invoke' });
    await updateProgress(input.organizationId, {
      status: 'failed', startedAt, queriesRun,
      insightsFound: 0, error: (error as Error).message,
    });
  }
}
