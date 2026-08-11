// apps/api/src/services/agents/firmResearchAgent/state.ts
import { Annotation } from '@langchain/langgraph';

export interface PortfolioCompany {
  name: string;
  sector: string;
  status: string;
  verified: boolean;
}

export interface RecentDeal {
  title: string;
  date: string;
  source: string;
}

export interface FirmProfile {
  description: string;
  strategy: string;
  sectors: string[];
  checkSizeRange: string;
  aum: string;
  teamSize: string;
  headquarters: string;
  foundedYear: string;
  investmentCriteria: string;
  keyDifferentiators: string;
  portfolioCompanies: PortfolioCompany[];
  recentDeals: RecentDeal[];
  confidence: 'high' | 'medium' | 'low';
  enrichedAt: string;
  sources: string[];
  // Phase 2 deep research additions
  socialPresence?: {
    twitter?: string;
    youtube?: string;
    newsletter?: string;
    podcast?: string;
    blog?: string;
  };
  pressArticles?: Array<{
    title: string;
    url: string;
    date: string;
    summary: string;
  }>;
  communityMentions?: string[];
  coInvestors?: string[];
  competitorFirms?: string[];
  deepResearchComplete?: boolean;
  deepResearchCompletedAt?: string;
  deepResearchInsightsCount?: number;
}

export interface PersonProfile {
  title: string;
  role: string;
  bio: string;
  experience: string[];
  education: string;
  expertise: string[];
  linkedinUrl: string;
  yearsInPE: string;
  notableDeals: string[];
  verified: boolean;
  // Phase 2 deep research additions
  socialHandles?: {
    twitter?: string;
    youtube?: string;
    github?: string;
    blog?: string;
  };
  interviews?: Array<{
    title: string;
    url: string;
    platform: string;
  }>;
  publicContent?: string[];
  networkConnections?: string[];
}

export interface AgentStep {
  timestamp: string;
  node: string;
  message: string;
  detail?: string;
}

export const FirmResearchState = Annotation.Root({
  // Input
  websiteUrl: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  linkedinUrl: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  firmName: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  // Firm-provided document / free text (uploaded in Settings → Firm Profile).
  // Treated as an authoritative source during synthesis; lets a profile be
  // built even when no website/LinkedIn is available.
  documentText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  userId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  organizationId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // Gathered data
  websiteText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  firmSearchResults: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  personSearchResults: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // Output
  firmProfile: Annotation<FirmProfile | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  personProfile: Annotation<PersonProfile | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  sources: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  status: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => 'pending',
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // Append-only step log
  steps: Annotation<AgentStep[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type FirmResearchStateType = typeof FirmResearchState.State;
