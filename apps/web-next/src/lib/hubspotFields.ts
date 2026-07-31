// ---------------------------------------------------------------------------
// Presentation helpers for the `hubspotProperties` JSONB blob written by the
// HubSpot importer (apps/api/src/services/hubspot/). The importer stores every
// property it fetched that isn't promoted to a first-class column, keyed by
// HubSpot's internal property name — so the UI has to make those readable.
// ---------------------------------------------------------------------------

/**
 * HubSpot's standard property names are lowercase and unspaced, so the generic
 * snake_case rule below turns them into things like "Numberofemployees".
 * Spell out the ones a client actually reads.
 */
const KNOWN_LABELS: Record<string, string> = {
  closedate: "Close Date",
  createdate: "Created In HubSpot",
  dealtype: "Deal Type",
  hs_deal_stage_probability: "Stage Probability",
  numberofemployees: "Employees",
  annualrevenue: "Annual Revenue",
  lifecyclestage: "Lifecycle Stage",
  hs_lead_status: "Lead Status",
  associatedcompanyid: "HubSpot Company ID",
  linkedin_company_page: "LinkedIn",
  founded_year: "Founded",
  mobilephone: "Mobile",
  jobtitle: "Job Title",
  firstname: "First Name",
  lastname: "Last Name",
  zip: "Postcode",
  dealstage: "HubSpot Stage",
};

/** ISO-8601 timestamps as HubSpot returns them for date properties. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

export function humanizeHubspotKey(key: string): string {
  const known = KNOWN_LABELS[key];
  if (known) return known;
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatHubspotValue(value: string): string {
  if (!ISO_DATE.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // Fixed locale + UTC so the rendered day can't drift with the viewer's zone.
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface HubspotField {
  key: string;
  label: string;
  value: string;
}

/** Blank-stripped, label-sorted fields ready to render. */
export function visibleHubspotFields(
  properties: Record<string, string | null> | null | undefined,
): HubspotField[] {
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ({
      key,
      label: humanizeHubspotKey(key),
      value: formatHubspotValue(String(value)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
