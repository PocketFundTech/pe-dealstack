/** One association entry. `type` is e.g. "deal_to_company" (primary) or "deal_to_company_unlabeled". */
export interface HubSpotAssociation {
  id: string;
  type?: string;
}

// Raw record shape returned by HubSpot CRM v3 list endpoints.
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: {
    companies?: { results: HubSpotAssociation[] };
    contacts?: { results: HubSpotAssociation[] };
    deals?: { results: HubSpotAssociation[] };
  };
}

export interface MappedCompany {
  hubspotId: string;
  name: string;
  industry: string | null;
  website: string | null;
  description: string | null;
  hubspotProperties: Record<string, string | null>;
}

export interface MappedContact {
  hubspotId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company: string | null; // free-text company name (matches Contact schema)
  hubspotProperties: Record<string, string | null>;
}

/** Mirrors the Deal.stage enum in apps/api/src/routes/deals-schemas.ts. */
export type DealStage =
  | 'INITIAL_REVIEW' | 'DUE_DILIGENCE' | 'IOI_SUBMITTED' | 'LOI_SUBMITTED'
  | 'NEGOTIATION' | 'CLOSING' | 'PASSED' | 'CLOSED_WON' | 'CLOSED_LOST';

export interface MappedDeal {
  hubspotId: string;
  name: string;
  dealSize: number | null;
  /** null when the HubSpot stage has no Avise equivalent — leave the deal alone. */
  stage: DealStage | null;
  description: string | null;
  associatedCompanyHubspotId: string | null;
  /** Other companies on the deal (not the primary), de-duplicated. */
  otherCompanyHubspotIds: string[];
  /** Contacts associated with the deal in HubSpot, de-duplicated. */
  contactHubspotIds: string[];
  /** HubSpot owner id (`hubspot_owner_id`), or null. */
  ownerHubspotId: string | null;
  customFields: Record<string, unknown>;
  hubspotProperties: Record<string, string | null>;
}

/** HubSpot's five engagement ("activity") object types. */
export type EngagementType = 'notes' | 'calls' | 'meetings' | 'emails' | 'tasks';

/** Mirrors the ContactInteraction.type CHECK constraint in contacts-migration.sql. */
export type InteractionType = 'NOTE' | 'MEETING' | 'CALL' | 'EMAIL' | 'OTHER';

export interface MappedEngagement {
  hubspotId: string;
  interactionType: InteractionType;
  title: string | null;
  description: string | null;
  /** ISO timestamp, or null if HubSpot returned no usable timestamp. */
  date: string | null;
  /** HubSpot contact ids this engagement is associated with — may be empty. */
  associatedContactHubspotIds: string[];
  /**
   * HubSpot deal ids this engagement is associated with — may be empty.
   * Used as a fallback when no contact resolves: PE workflows routinely log
   * activity at the deal level (diligence notes, internal call recaps) with
   * no single contact attached, so the import falls back to the deal's
   * activity feed instead of dropping the record.
   */
  associatedDealHubspotIds: string[];
  /** HubSpot file ids attached to this engagement (`hs_attachment_ids`). */
  attachmentIds: string[];
}

export type HubSpotObjectType = 'companies' | 'contacts' | 'deals' | EngagementType;

/** A HubSpot user who can own records. */
export interface HubSpotOwner {
  id: string;
  email: string | null;
  name: string | null;
}

/** Metadata from GET /files/v3/files/{id}. `name` excludes the extension. */
export interface HubSpotFileMeta {
  id: string;
  name: string;
  extension: string | null;
  size: number | null;
}

/** Phases of an import job: the HubSpot objects, then local file download. */
export type ImportPhase = HubSpotObjectType | 'files';

/** Per-phase counters stored in ImportJob.objectCounts (JSONB — no migration). */
export interface ImportCounters {
  processed: number; created: number; updated: number; failed: number; skipped: number;
  /** Records HubSpot says this object has (for "X of Y" progress); null if unknown. */
  total?: number | null;
  /** Of `updated`: existing Avise rows linked instead of duplicated. Absent on older jobs. */
  matched?: number;
  /** Deals: new deal↔contact links. */
  contactLinks?: number;
  /** Deals: deals whose HubSpot owner is their Avise Lead Partner. */
  ownersMatched?: number;
  /** Why records were skipped, e.g. { no_deal: 3, too_large: 1 }. */
  reasons?: Record<string, number>;
}
