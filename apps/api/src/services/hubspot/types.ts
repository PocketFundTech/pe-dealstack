// Raw record shape returned by HubSpot CRM v3 list endpoints.
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: {
    companies?: { results: Array<{ id: string }> };
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
  /** null when the HubSpot stage has no PE OS equivalent — leave the deal alone. */
  stage: DealStage | null;
  description: string | null;
  associatedCompanyHubspotId: string | null;
  customFields: Record<string, unknown>;
  hubspotProperties: Record<string, string | null>;
}

export type HubSpotObjectType = 'companies' | 'contacts' | 'deals';
