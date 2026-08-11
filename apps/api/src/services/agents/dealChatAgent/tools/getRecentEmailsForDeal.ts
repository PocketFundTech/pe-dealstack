// ─── get_recent_emails_for_deal tool ──────────────────────────────
// LIVE Gmail read for the current user, scoped to one deal.
// Query: Gmail messages in the last N days that EITHER involve a known
// contact email OR mention the deal's company name (subject or body).
// Returns markdown so the LLM can extract action items / follow-ups.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import {
  getDecryptedTokens,
  saveTokens,
  markStatus,
} from '../../../../integrations/_platform/tokenStore.js';
import {
  getMessageFull,
  listMessagesForDeal,
  refreshAccessToken,
} from '../../../../integrations/gmail/client.js';
import type { Integration } from '../../../../integrations/_platform/types.js';
import type { GmailMessageFull } from '../../../../integrations/gmail/types.js';
import { getCached, setCached } from './_cache.js';

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const PARALLEL_FETCH_LIMIT = 10;

/** Run an async mapper across `items` with at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function formatDateOnly(iso: string | undefined): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function singleLine(s: string, maxLen: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen).trimEnd() + '…';
}

/**
 * Resolve auth UUID (req.user?.id) to the internal User.id used as
 * Integration.userId. Integrations are keyed on the internal id.
 */
async function resolveInternalUserId(authOrInternalId: string): Promise<string | null> {
  // First try as authId (the common case from req.user.id)
  const { data: byAuth } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authOrInternalId)
    .maybeSingle();
  if (byAuth?.id) return byAuth.id as string;
  // Fall back: caller may have passed the internal id already
  const { data: byId } = await supabase
    .from('User')
    .select('id')
    .eq('id', authOrInternalId)
    .maybeSingle();
  return (byId?.id as string | undefined) ?? null;
}

async function loadDealContactEmails(dealId: string, orgId: string): Promise<string[]> {
  // ContactDeal -> Contact join. Restrict by orgId on Contact so cross-org
  // joins are impossible even if the link table is mis-populated.
  const { data, error } = await supabase
    .from('ContactDeal')
    .select('Contact:contactId(email, organizationId)')
    .eq('dealId', dealId);
  if (error) {
    log.warn('getRecentEmailsForDeal: contact lookup failed', { error: error.message });
    return [];
  }
  // Supabase typegen sometimes shapes the nested relation as an array, sometimes
  // as a single object — normalise to "first contact" either way.
  const emails: string[] = [];
  const rows = (data ?? []) as unknown as Array<{
    Contact: { email: string | null; organizationId: string } | Array<{ email: string | null; organizationId: string }> | null;
  }>;
  for (const row of rows) {
    const c = Array.isArray(row.Contact) ? row.Contact[0] : row.Contact;
    if (!c || c.organizationId !== orgId) continue;
    if (c.email) emails.push(c.email.trim().toLowerCase());
  }
  return Array.from(new Set(emails.filter(Boolean)));
}

async function loadDealCompanyTerms(dealId: string, orgId: string): Promise<{ companyName: string; codename: string }> {
  const { data } = await supabase
    .from('Deal')
    .select('name, company:companyId(name)')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .maybeSingle();
  const company = (data as any)?.company;
  const companyName: string =
    (Array.isArray(company) ? company[0]?.name : company?.name) ?? '';
  const codename: string = (data as any)?.name ?? '';
  return { companyName: companyName ?? '', codename: codename ?? '' };
}

/**
 * Fetch a fresh access token for this integration, refreshing if expired.
 * Returns null and marks status='error' if refresh fails — caller surfaces
 * the "reconnect Gmail" message to the user.
 */
async function ensureFreshGmailToken(integration: Integration): Promise<string | null> {
  const { accessToken, refreshToken } = await getDecryptedTokens(integration);
  if (!accessToken) return null;

  const expiresAt = integration.tokenExpiresAt ? Date.parse(integration.tokenExpiresAt) : 0;
  const now = Date.now();
  if (!expiresAt || expiresAt - now > TOKEN_REFRESH_SAFETY_MS) {
    return accessToken;
  }
  if (!refreshToken) {
    await markStatus(integration.id, 'error', 'no refresh token').catch(() => {});
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await saveTokens({
      integrationId: integration.id,
      accessToken: refreshed.access_token,
      refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn('getRecentEmailsForDeal: gmail token refresh failed', { integrationId: integration.id, msg });
    await markStatus(integration.id, 'error', `refresh failed: ${msg}`).catch(() => {});
    return null;
  }
}

export function makeGetRecentEmailsForDealTool(
  dealId: string,
  orgId: string,
  userId?: string
) {
  return tool(
    async (rawArgs: { lookback_days?: number; limit?: number }) => {
      const lookbackDays = Math.min(Math.max(rawArgs.lookback_days ?? 30, 1), 90);
      const limit = Math.min(Math.max(rawArgs.limit ?? 25, 1), 50);
      const args = { lookback_days: lookbackDays, limit };

      // Entry-point log — answers the "was this tool actually called?" question
      // when the agent's reply seems thin. `cached: true/false` on the second
      // log line tells you whether Gmail was actually hit or served from cache.
      log.info('[get_recent_emails_for_deal] called', {
        dealId,
        userId: userId ?? null,
        args,
      });

      if (!userId) {
        return 'User context not available. Cannot read Gmail for this request.';
      }

      const cacheKey = `get_recent_emails_for_deal:${userId}:${dealId}:${JSON.stringify(args)}`;
      const cached = getCached(cacheKey);
      if (cached) {
        log.info('[get_recent_emails_for_deal] served from cache', { dealId });
        return cached;
      }

      try {
        const internalUserId = await resolveInternalUserId(userId);
        if (!internalUserId) {
          return 'Gmail not connected for this user. To enable email-based follow-ups, connect Gmail in Settings → Integrations.';
        }

        const { data: integration } = await supabase
          .from('Integration')
          .select('*')
          .eq('userId', internalUserId)
          .eq('provider', 'gmail')
          .eq('status', 'connected')
          .maybeSingle();
        if (!integration) {
          return 'Gmail not connected for this user. To enable email-based follow-ups, connect Gmail in Settings → Integrations.';
        }

        const accessToken = await ensureFreshGmailToken(integration as Integration);
        if (!accessToken) {
          return 'Gmail connection expired. Please reconnect Gmail in Settings → Integrations.';
        }

        const [knownEmails, { companyName, codename }] = await Promise.all([
          loadDealContactEmails(dealId, orgId),
          loadDealCompanyTerms(dealId, orgId),
        ]);

        const companyTerms: string[] = [];
        if (companyName) companyTerms.push(companyName);
        // Codename can be misleading (often a random internal label) — only
        // include if obviously distinct from the company name.
        if (codename && codename.toLowerCase() !== companyName.toLowerCase()) {
          companyTerms.push(codename);
        }

        if (knownEmails.length === 0 && companyTerms.length === 0) {
          return 'No contacts or company name available to scope Gmail search for this deal. Add at least one contact to the deal first.';
        }

        const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
        const headers = await listMessagesForDeal(
          accessToken,
          since,
          knownEmails,
          companyTerms,
          limit
        );

        if (headers.length === 0) {
          const scope = [
            knownEmails.length ? `${knownEmails.length} contact(s)` : null,
            companyTerms.length ? `company "${companyName}"` : null,
          ].filter(Boolean).join(' + ');
          return `No emails found in the last ${lookbackDays} days matching this deal (scope: ${scope}).`;
        }

        const ids = headers.slice(0, limit);
        const fetched = await mapWithConcurrency<{ id: string; threadId: string }, GmailMessageFull | null>(
          ids,
          PARALLEL_FETCH_LIMIT,
          async (h) => {
            try {
              return await getMessageFull(accessToken, h.id);
            } catch (err) {
              log.warn('getRecentEmailsForDeal: per-message fetch failed (skipping)', {
                messageId: h.id,
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
          }
        );
        const messages = fetched.filter((m): m is GmailMessageFull => m !== null);

        // Sort newest first by Date header (fall back to id-order if parse fails)
        messages.sort((a, b) => {
          const da = Date.parse(a.headers.Date);
          const db = Date.parse(b.headers.Date);
          if (isNaN(da) && isNaN(db)) return 0;
          if (isNaN(da)) return 1;
          if (isNaN(db)) return -1;
          return db - da;
        });

        const scopeLabel = [
          knownEmails.length ? 'contacts' : null,
          companyTerms.length ? 'companyName' : null,
        ].filter(Boolean).join(' + ');

        const lines: string[] = [
          `**Recent emails for this deal (${messages.length} messages from last ${lookbackDays} days, scope: ${scopeLabel}):**\n`,
        ];

        messages.forEach((m, idx) => {
          const subject = m.headers.Subject || '(no subject)';
          const from = m.headers.From || 'unknown';
          const to = m.headers.To || 'unknown';
          const date = formatDateOnly(m.headers.Date);
          const body = m.body || m.snippet || '(no body)';
          lines.push(
            `${idx + 1}. **${subject}** — From ${from} to ${to} _(${date})_`,
            `   > ${singleLine(body, 600)}`,
            ''
          );
        });

        const output = lines.join('\n').trimEnd();
        setCached(cacheKey, output, CACHE_TTL_MS);
        return output;
      } catch (error) {
        log.error('getRecentEmailsForDeal tool error', {
          dealId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'Failed to read Gmail. Please try again.';
      }
    },
    {
      name: 'get_recent_emails_for_deal',
      description:
        'Read the CURRENT USER\'s Gmail for recent emails involving this deal — matched by known contact emails OR by deal company name in subject/body. Returns up to `limit` messages from the last `lookback_days` days with subject, sender, date, and a body excerpt. Use this for /follow-ups, action-item extraction, or "what did we last say about X" questions. Requires the user to have connected Gmail in Settings → Integrations.',
      schema: z.object({
        lookback_days: z.number().int().min(1).max(90).optional().describe('How many days back to search Gmail (default 30, max 90).'),
        limit: z.number().int().min(1).max(50).optional().describe('Max emails to return (default 25, max 50).'),
      }),
    }
  );
}
