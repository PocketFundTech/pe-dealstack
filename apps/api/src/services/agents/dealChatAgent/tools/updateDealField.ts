// ─── update_deal_field tool ──────────────────────────────────────
// Mutates fields on the current Deal row, with special handling for
// leadPartner / analyst (resolves user IDs and writes DealTeamMember).
//
// Plain BetaRunnableTool object — see addNote.ts for why betaZodTool()
// isn't used here.

import { z } from 'zod';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import type { ToolEmit } from '../types.js';

const FIELDS = [
  'leadPartner', 'analyst', 'source', 'priority', 'industry', 'description',
  'name', 'currency', 'revenue', 'ebitda', 'dealSize', 'irrProjected', 'mom',
  'targetCloseDate', 'grossMargin',
] as const;

export const inputSchema = z.object({
  field: z.enum(FIELDS),
  value: z.string().describe('New value. For leadPartner/analyst this can be a user ID, email, or full name — the tool resolves it to a real org member and returns an error if no unique match. For numeric fields (revenue, ebitda, dealSize, irrProjected, mom, grossMargin) pass the number in millions. For targetCloseDate use ISO date (YYYY-MM-DD).'),
  userName: z.string().optional().describe('Name of user being assigned (for confirmation message)'),
});

export function makeUpdateDealFieldTool(dealId: string, orgId: string, emit: ToolEmit) {
  return {
    type: 'custom' as const,
    name: 'update_deal_field',
    description: 'Update a field on the current deal. Use when the user asks to change deal properties like name, metrics, team assignments, etc.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: [...FIELDS] },
        value: {
          type: 'string',
          description: 'New value. For leadPartner/analyst this can be a user ID, email, or full name — the tool resolves it to a real org member and returns an error if no unique match. For numeric fields (revenue, ebitda, dealSize, irrProjected, mom, grossMargin) pass the number in millions. For targetCloseDate use ISO date (YYYY-MM-DD).',
        },
        userName: { type: 'string', description: 'Name of user being assigned (for confirmation message)' },
      },
      required: ['field', 'value'],
    },
    parse: (input: unknown) => inputSchema.parse(input),
    run: async ({ field, value, userName }: z.infer<typeof inputSchema>) => {
      try {
        if (field === 'leadPartner' || field === 'analyst') {
          const role = field === 'leadPartner' ? 'LEAD' : 'MEMBER';

          // The LLM tends to pass a name ("Pushkar") instead of a UUID even
          // though the schema description asks for an ID. Resolve to a real
          // userId here — UUID stays as-is, email matches an exact user,
          // anything else is treated as a name (case-insensitive exact, then
          // contains-fallback). All scoped to the same org.
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          let resolvedUserId: string | null = null;
          let resolvedName: string | null = userName ?? null;
          if (UUID_RE.test(value)) {
            const { data } = await supabase
              .from('User')
              .select('id, name')
              .eq('id', value)
              .eq('organizationId', orgId)
              .maybeSingle();
            if (data) {
              resolvedUserId = data.id;
              resolvedName = resolvedName ?? data.name;
            }
          } else if (value.includes('@')) {
            const { data } = await supabase
              .from('User')
              .select('id, name')
              .ilike('email', value)
              .eq('organizationId', orgId)
              .maybeSingle();
            if (data) {
              resolvedUserId = data.id;
              resolvedName = resolvedName ?? data.name;
            }
          } else {
            // Try exact (case-insensitive) match first.
            const { data: exact } = await supabase
              .from('User')
              .select('id, name')
              .ilike('name', value)
              .eq('organizationId', orgId)
              .limit(1)
              .maybeSingle();
            if (exact) {
              resolvedUserId = exact.id;
              resolvedName = resolvedName ?? exact.name;
            } else {
              // Fall back to substring match — e.g. "Pushkar" matches "Pushkar Rathod".
              const { data: fuzzy } = await supabase
                .from('User')
                .select('id, name')
                .ilike('name', `%${value}%`)
                .eq('organizationId', orgId)
                .limit(2);
              if (fuzzy && fuzzy.length === 1) {
                resolvedUserId = fuzzy[0].id;
                resolvedName = resolvedName ?? fuzzy[0].name;
              } else if (fuzzy && fuzzy.length > 1) {
                return JSON.stringify({
                  success: false,
                  error: `"${value}" matches multiple users (${fuzzy.map(u => u.name).join(', ')}). Be more specific.`,
                });
              }
            }
          }

          if (!resolvedUserId) {
            return JSON.stringify({
              success: false,
              error: `Could not find a team member matching "${value}". Try the user's full name or email.`,
            });
          }

          const { data: existingMember } = await supabase
            .from('DealTeamMember')
            .select('id')
            .eq('dealId', dealId)
            .eq('userId', resolvedUserId)
            .maybeSingle();

          if (existingMember) {
            const { error: updErr } = await supabase
              .from('DealTeamMember')
              .update({ role })
              .eq('id', existingMember.id);
            if (updErr) {
              log.error('updateDealField team-role update failed', updErr);
              return JSON.stringify({ success: false, error: 'Failed to update team member role.' });
            }
          } else {
            const { error: insErr } = await supabase
              .from('DealTeamMember')
              .insert({ dealId, userId: resolvedUserId, role });
            if (insErr) {
              log.error('updateDealField team-member insert failed', insErr);
              return JSON.stringify({ success: false, error: 'Failed to add team member.' });
            }
          }

          // The deal page UI reads Lead Partner from Deal.assignedTo (relation
          // exposed as `assignedUser`), and Analyst from team members where
          // role=MEMBER. So:
          //   - leadPartner → also UPDATE Deal.assignedTo = userId
          //   - analyst    → no extra Deal update (DealTeamMember row is the
          //     source of truth, already updated above)
          // (There are no Deal.leadPartnerId / Deal.analystId columns —
          // confirmed via routes/deals.ts and the deal-layout.tsx renderer.)
          const dealUpdate: Record<string, string> =
            field === 'leadPartner'
              ? { assignedTo: resolvedUserId, updatedAt: new Date().toISOString() }
              : { updatedAt: new Date().toISOString() };
          const { error: dealErr } = await supabase
            .from('Deal')
            .update(dealUpdate)
            .eq('id', dealId)
            .eq('organizationId', orgId);
          if (dealErr) {
            log.error('updateDealField deal-row update failed', dealErr);
            return JSON.stringify({ success: false, error: 'Failed to persist on the deal record.' });
          }

          await supabase.from('Activity').insert({
            dealId,
            type: 'TEAM_MEMBER_ADDED',
            title: `${field === 'leadPartner' ? 'Lead Partner' : 'Analyst'} Updated`,
            description: `${resolvedName || 'Team member'} assigned as ${field === 'leadPartner' ? 'Lead Partner' : 'Analyst'}`,
          });

          emit({ type: 'update', update: { field, value: resolvedUserId, userName: resolvedName } });
          return JSON.stringify({ success: true, field, value: resolvedUserId, userName: resolvedName });
        }

        const updateData: Record<string, any> = {};
        const numericFields = ['revenue', 'ebitda', 'dealSize', 'irrProjected', 'mom', 'grossMargin'];
        updateData[field] = numericFields.includes(field) ? parseFloat(value) : value;
        updateData.updatedAt = new Date().toISOString();

        await supabase.from('Deal').update(updateData).eq('id', dealId);
        await supabase.from('Activity').insert({
          dealId,
          type: 'STATUS_UPDATED',
          title: `${field.charAt(0).toUpperCase() + field.slice(1)} Updated`,
          description: `Changed to: ${value}`,
        });

        emit({ type: 'update', update: { field, value } });
        return JSON.stringify({ success: true, field, value });
      } catch (error) {
        log.error('updateDealField tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to update deal field' });
      }
    },
  };
}
