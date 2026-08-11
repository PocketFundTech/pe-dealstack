// ─── get_upcoming_meetings_for_deal tool ──────────────────────────
// LIVE Google Calendar read for the current user, filtered to events
// relevant to this deal (attendee email match OR company-name mention
// in summary/description). Window: past N days .. future M days.

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
  listEventsBetween,
  refreshAccessToken,
} from '../../../../integrations/googleCalendar/client.js';
import type { Integration } from '../../../../integrations/_platform/types.js';
import type { GoogleCalendarEvent } from '../../../../integrations/googleCalendar/types.js';
import { getCached, setCached } from './_cache.js';

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveInternalUserId(authOrInternalId: string): Promise<string | null> {
  const { data: byAuth } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authOrInternalId)
    .maybeSingle();
  if (byAuth?.id) return byAuth.id as string;
  const { data: byId } = await supabase
    .from('User')
    .select('id')
    .eq('id', authOrInternalId)
    .maybeSingle();
  return (byId?.id as string | undefined) ?? null;
}

async function loadDealContactEmails(dealId: string, orgId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('ContactDeal')
    .select('Contact:contactId(email, organizationId)')
    .eq('dealId', dealId);
  if (error) {
    log.warn('getUpcomingMeetingsForDeal: contact lookup failed', { error: error.message });
    return [];
  }
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

async function loadDealCompanyName(dealId: string, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('Deal')
    .select('name, company:companyId(name)')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .maybeSingle();
  const company = (data as any)?.company;
  return (
    (Array.isArray(company) ? company[0]?.name : company?.name) ??
    (data as any)?.name ??
    ''
  );
}

async function ensureFreshCalendarToken(integration: Integration): Promise<string | null> {
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
    log.warn('getUpcomingMeetingsForDeal: calendar token refresh failed', { integrationId: integration.id, msg });
    await markStatus(integration.id, 'error', `refresh failed: ${msg}`).catch(() => {});
    return null;
  }
}

function eventStartMs(e: GoogleCalendarEvent): number {
  const ref = e.start;
  if (!ref) return Number.MAX_SAFE_INTEGER;
  if (ref.dateTime) {
    const t = Date.parse(ref.dateTime);
    return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  }
  if (ref.date) {
    const t = Date.parse(ref.date + 'T00:00:00Z');
    return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  }
  return Number.MAX_SAFE_INTEGER;
}

function formatEventStart(e: GoogleCalendarEvent): string {
  const ref = e.start;
  if (!ref) return 'unknown time';
  if (ref.dateTime) {
    const d = new Date(ref.dateTime);
    if (isNaN(d.getTime())) return ref.dateTime;
    // YYYY-MM-DD HH:MM (UTC) — keep simple/deterministic
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  if (ref.date) return `${ref.date} (all-day)`;
  return 'unknown time';
}

function formatDuration(e: GoogleCalendarEvent): string {
  const startMs = e.start?.dateTime ? Date.parse(e.start.dateTime) : NaN;
  const endMs = e.end?.dateTime ? Date.parse(e.end.dateTime) : NaN;
  if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return '';
  const totalMin = Math.round((endMs - startMs) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + '…';
}

export function makeGetUpcomingMeetingsForDealTool(
  dealId: string,
  orgId: string,
  userId?: string
) {
  return tool(
    async (rawArgs: { past_days?: number; future_days?: number; limit?: number }) => {
      const pastDays = Math.min(Math.max(rawArgs.past_days ?? 7, 0), 30);
      const futureDays = Math.min(Math.max(rawArgs.future_days ?? 14, 0), 60);
      const limit = Math.min(Math.max(rawArgs.limit ?? 25, 1), 50);
      const args = { past_days: pastDays, future_days: futureDays, limit };

      // Entry-point log — answers the "was this tool actually called?" question
      // when the agent's reply seems thin. `cached: true/false` on the second
      // log line tells you whether Calendar was actually hit or served from cache.
      log.info('[get_upcoming_meetings_for_deal] called', {
        dealId,
        userId: userId ?? null,
        args,
      });

      if (!userId) {
        return 'User context not available. Cannot read Google Calendar for this request.';
      }

      const cacheKey = `get_upcoming_meetings_for_deal:${userId}:${dealId}:${JSON.stringify(args)}`;
      const cached = getCached(cacheKey);
      if (cached) {
        log.info('[get_upcoming_meetings_for_deal] served from cache', { dealId });
        return cached;
      }

      try {
        const internalUserId = await resolveInternalUserId(userId);
        if (!internalUserId) {
          return 'Google Calendar not connected for this user. To enable meeting-aware follow-ups, connect Google Calendar in Settings → Integrations.';
        }

        const { data: integration } = await supabase
          .from('Integration')
          .select('*')
          .eq('userId', internalUserId)
          .eq('provider', 'google_calendar')
          .eq('status', 'connected')
          .maybeSingle();
        if (!integration) {
          return 'Google Calendar not connected for this user. To enable meeting-aware follow-ups, connect Google Calendar in Settings → Integrations.';
        }

        const accessToken = await ensureFreshCalendarToken(integration as Integration);
        if (!accessToken) {
          return 'Google Calendar connection expired. Please reconnect Google Calendar in Settings → Integrations.';
        }

        const [knownEmails, companyName] = await Promise.all([
          loadDealContactEmails(dealId, orgId),
          loadDealCompanyName(dealId, orgId),
        ]);

        const knownEmailSet = new Set(knownEmails.map(e => e.toLowerCase()));
        const companyNeedle = companyName.trim().toLowerCase();

        if (knownEmailSet.size === 0 && !companyNeedle) {
          return 'No contacts or company name available to filter calendar events for this deal. Add at least one contact to the deal first.';
        }

        const now = Date.now();
        const timeMin = new Date(now - pastDays * 24 * 60 * 60 * 1000);
        const timeMax = new Date(now + futureDays * 24 * 60 * 60 * 1000);

        const allEvents = await listEventsBetween(accessToken, timeMin, timeMax);

        const relevant = allEvents.filter(e => {
          if (e.status === 'cancelled') return false;
          // Attendee email match
          if (knownEmailSet.size > 0 && e.attendees && e.attendees.length) {
            for (const a of e.attendees) {
              const email = (a.email ?? '').toLowerCase();
              if (email && knownEmailSet.has(email)) return true;
            }
          }
          // Company-name substring (summary or description, case-insensitive)
          if (companyNeedle) {
            const summary = (e.summary ?? '').toLowerCase();
            const desc = (e.description ?? '').toLowerCase();
            if (summary.includes(companyNeedle) || desc.includes(companyNeedle)) return true;
          }
          return false;
        });

        relevant.sort((a, b) => eventStartMs(a) - eventStartMs(b));
        const capped = relevant.slice(0, limit);

        if (capped.length === 0) {
          return `No calendar events related to this deal in the window (past ${pastDays}d / next ${futureDays}d).`;
        }

        const lines: string[] = [
          `**Meetings related to this deal (past ${pastDays} days + next ${futureDays} days, ${capped.length} events):**\n`,
        ];

        capped.forEach((e, idx) => {
          const title = e.summary || '(no title)';
          const startStr = formatEventStart(e);
          const dur = formatDuration(e);
          const attendees = (e.attendees ?? [])
            .map(a => a.email)
            .filter((s): s is string => !!s);
          const attendeesStr = attendees.length ? attendees.join(', ') : '(none listed)';
          lines.push(`${idx + 1}. **${title}** — ${startStr}${dur ? ` (duration: ${dur})` : ''}`);
          lines.push(`   Attendees: ${attendeesStr}`);
          if (e.description) {
            lines.push(`   ${truncate(e.description, 300)}`);
          }
          lines.push('');
        });

        const output = lines.join('\n').trimEnd();
        setCached(cacheKey, output, CACHE_TTL_MS);
        return output;
      } catch (error) {
        log.error('getUpcomingMeetingsForDeal tool error', {
          dealId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'Failed to read Google Calendar. Please try again.';
      }
    },
    {
      name: 'get_upcoming_meetings_for_deal',
      description:
        'Read the CURRENT USER\'s Google Calendar for meetings related to this deal — matched by attendee email (deal contacts) OR company-name mention in title/description. Window: past `past_days` days to next `future_days` days. Use this for /follow-ups, meeting prep, or "what\'s on my calendar with X" questions. Requires the user to have connected Google Calendar in Settings → Integrations.',
      schema: z.object({
        past_days: z.number().int().min(0).max(30).optional().describe('How many days into the past to include (default 7, max 30).'),
        future_days: z.number().int().min(0).max(60).optional().describe('How many days into the future to include (default 14, max 60).'),
        limit: z.number().int().min(1).max(50).optional().describe('Max events to return (default 25, max 50).'),
      }),
    }
  );
}
