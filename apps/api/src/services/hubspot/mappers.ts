import type { DealStage, HubSpotRecord, MappedCompany, MappedContact, MappedDeal } from './types.js';

// Property keys we promote to first-class columns; everything else → hubspotProperties.
const COMPANY_STD = new Set(['name', 'industry', 'domain', 'website', 'description']);
const CONTACT_STD = new Set(['firstname', 'lastname', 'email', 'phone', 'jobtitle']);
const DEAL_STD = new Set(['dealname', 'amount']);

function rest(properties: Record<string, string | null>, std: Set<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!std.has(k)) out[k] = v;
  }
  return out;
}

/**
 * HubSpot deal-stage label → PE OS Deal.stage.
 * Labels are free text per pipeline, so we match on normalised keywords and
 * return null when nothing fits — better to leave the stage alone than to
 * guess a deal into the wrong pipeline column.
 */
const STAGE_PATTERNS: Array<[RegExp, DealStage]> = [
  // No bare \bwon\b / \blost\b / \bpass\b: "pass" is standard M&A screening
  // terminology for an ADVANCING deal ("first pass review", "1st pass
  // approval"), and "at risk of being lost" is still an open deal — a
  // confident-but-wrong guess here is worse than leaving the stage unmapped.
  [/\bclosed?\s*won\b/, 'CLOSED_WON'],
  [/\bclosed?\s*lost\b/, 'CLOSED_LOST'],
  [/\bpassed\b|\bdeclined\b|\brejected\b/, 'PASSED'],
  [/\bdue\s*diligence\b|\bdiligence\b|\bdd\b/, 'DUE_DILIGENCE'],
  [/\bioi\b|\bindication\s*of\s*interest\b/, 'IOI_SUBMITTED'],
  [/\bloi\b|\bletter\s*of\s*intent\b/, 'LOI_SUBMITTED'],
  [/\bnegotiat/, 'NEGOTIATION'],
  [/\bclosing\b|\bcontract\s*sent\b|\bsigning\b/, 'CLOSING'],
  [/\binitial\s*review\b|\bqualif|\bappointment\b|\blead\b|\bprospect|\bsourcing\b|\bnew\b/, 'INITIAL_REVIEW'],
];

export function hubspotStageToDealStage(label: string | null | undefined): DealStage | null {
  if (!label) return null;
  const norm = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [pattern, stage] of STAGE_PATTERNS) if (pattern.test(norm)) return stage;
  return null;
}

export function mapCompany(r: HubSpotRecord): MappedCompany {
  const p = r.properties;
  return {
    hubspotId: r.id,
    name: p.name?.trim() || 'Unknown Company',
    industry: p.industry || null,
    // `website` is the full URL; `domain` is the bare host — prefer the former.
    website: p.website || p.domain || null,
    description: p.description || null,
    hubspotProperties: rest(p, COMPANY_STD),
  };
}

export function mapContact(r: HubSpotRecord, companyName: string | null): MappedContact {
  const p = r.properties;
  return {
    hubspotId: r.id,
    firstName: p.firstname?.trim() || '',
    lastName: p.lastname?.trim() || '',
    email: p.email || null,
    phone: p.phone || null,
    title: p.jobtitle || null,
    company: companyName,
    hubspotProperties: rest(p, CONTACT_STD),
  };
}

/**
 * @param stageLabel Human label for `properties.dealstage`, resolved via
 *   HubSpotClient.listDealStageLabels(). Without it the raw internal id
 *   (often an opaque number on custom pipelines) is all we have.
 */
export function mapDeal(r: HubSpotRecord, stageLabel?: string | null): MappedDeal {
  const p = r.properties;
  const amount = p.amount != null && p.amount !== '' ? Number(p.amount) : null;
  const customFields: Record<string, unknown> = { source: 'hubspot' };
  const readableStage = stageLabel || p.dealstage;
  if (readableStage) customFields.dealstage = readableStage;
  if (p.pipeline) customFields.pipeline = p.pipeline;
  return {
    hubspotId: r.id,
    name: p.dealname?.trim() || 'Untitled HubSpot Deal',
    dealSize: amount != null && Number.isFinite(amount) ? amount : null,
    stage: hubspotStageToDealStage(readableStage),
    description: p.description || null,
    associatedCompanyHubspotId: r.associations?.companies?.results?.[0]?.id ?? null,
    customFields,
    hubspotProperties: rest(p, DEAL_STD),
  };
}
