import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

/**
 * Creates a fully-loaded Wagoner Industrial Supply sample deal for a new
 * organization. Includes: Company, Deal, VDR Folders, FinancialStatements,
 * Activities. Uses existing `tags` field with ['sample'] — no schema changes
 * needed.
 *
 * Financials are internally consistent at 1-decimal precision in $M:
 * - Income statement reconciles GP, OI, NI across all 3 years
 * - Balance sheet totals tie L&E both years
 * - Cash flow ties NI + D&A + ΔWC – capex – debt – divs to ΔCash
 */

const WAGONER_COMPANY = {
  name: 'Wagoner Industrial Supply',
  industry: 'Industrial Distribution',
  website: 'https://wagoner.example.com',
  description: 'Greenville, SC-based industrial distributor specializing in bearings, fasteners, fluid power, and MRO consumables. Family-owned, 3rd generation. Serves tier-1 manufacturing customers across the upstate SC and western NC corridor.',
};

const WAGONER_DEAL = {
  name: 'Wagoner Industrial Supply — Acquisition',
  stage: 'DUE_DILIGENCE',
  status: 'ACTIVE',
  industry: 'Industrial Distribution',
  description: 'Buyout of Wagoner Industrial Supply, a 60-year-old family-owned industrial distributor serving the upstate SC manufacturing belt. Founder (Sarah Wagoner-Hayes, 58) approaching retirement with no family successor. Recently signed multi-year contract with a new EV battery plant in upstate SC drives forward growth. Real estate held separately — sale-leaseback opportunity included.',
  aiThesis: 'Greenville-based industrial distributor, 60-year family business now 3rd generation. Revenue $9.8M → $12.4M (12% CAGR), EBITDA margins expanding 10% → 15% on pricing pass-through and product mix rationalization. Founder retiring; sale timed pre-ramp of new $1.2M/yr EV battery plant contract — captures de-risking premium without giving away post-ramp upside. Deal $9.5M (5x trailing EBITDA), with separate real estate sale-leaseback option. Key risks: (1) customer concentration, top 5 = 45% revenue (mitigant: 10+ year relationships, auto-renewing contracts); (2) founder-held supplier/customer relationships (mitigant: 12-month transition, 22-year-tenure GM); (3) no ERP, runs on QuickBooks + Excel (mitigant: ~$200K NetSuite capex post-close); (4) warehouse near 90% utilization (mitigant: adjacent 2-acre parcel available for $0.8M); (5) macro/cyclicality tracks regional manufacturing PMI (mitigant: EV plant contract is 5-year fixed-price floor).',
  revenue: 12.4,
  ebitda: 1.9,
  irrProjected: 22.5,
  mom: 2.8,
  dealSize: 9.5,
  icon: 'warehouse',
  priority: 'HIGH',
  tags: ['sample'],
};

const WAGONER_FOLDERS = [
  { name: 'Financials', description: 'Financial statements and models' },
  { name: 'Legal', description: 'Legal documents and agreements' },
  { name: 'Company Overview', description: 'Company presentations and background' },
];

// Income Statement line items (in millions USD).
// Reconciles: GP = Rev − COGS; OI = GP − SG&A − R&D − D&A;
// Pretax = OI − Interest + Other; NI = Pretax − Tax. EBITDA = OI + D&A.
const INCOME_STATEMENT_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    revenue: 12.4, costOfGoodsSold: 8.5, grossProfit: 3.9,
    sellingGeneralAdmin: 2.0, researchDevelopment: 0, depreciation: 0.2,
    operatingIncome: 1.7, interestExpense: 0.1, otherIncome: 0,
    pretaxIncome: 1.6, incomeTax: 0.4, netIncome: 1.2,
  },
  '2022': {
    revenue: 11.2, costOfGoodsSold: 7.8, grossProfit: 3.4,
    sellingGeneralAdmin: 2.0, researchDevelopment: 0, depreciation: 0.2,
    operatingIncome: 1.2, interestExpense: 0.1, otherIncome: 0,
    pretaxIncome: 1.1, incomeTax: 0.3, netIncome: 0.8,
  },
  '2021': {
    revenue: 9.8, costOfGoodsSold: 7.0, grossProfit: 2.8,
    sellingGeneralAdmin: 1.8, researchDevelopment: 0, depreciation: 0.2,
    operatingIncome: 0.8, interestExpense: 0.1, otherIncome: 0,
    pretaxIncome: 0.7, incomeTax: 0.2, netIncome: 0.5,
  },
};

// Balance Sheet line items (in millions USD). Totals tie: L&E = Assets.
const BALANCE_SHEET_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    cash: 0.5, accountsReceivable: 1.8, inventory: 1.6, otherCurrentAssets: 0.1,
    totalCurrentAssets: 4.0, propertyPlantEquipment: 0.8, intangibleAssets: 0.1,
    goodwill: 0, otherNonCurrentAssets: 0.1, totalAssets: 5.0,
    accountsPayable: 0.9, shortTermDebt: 0.3, accruedLiabilities: 0.3,
    totalCurrentLiabilities: 1.5, longTermDebt: 0.5, otherLiabilities: 0.1,
    totalLiabilities: 2.1, totalEquity: 2.9, totalLiabilitiesAndEquity: 5.0,
  },
  '2022': {
    cash: 0.4, accountsReceivable: 1.5, inventory: 1.4, otherCurrentAssets: 0.1,
    totalCurrentAssets: 3.4, propertyPlantEquipment: 0.7, intangibleAssets: 0.1,
    goodwill: 0, otherNonCurrentAssets: 0.1, totalAssets: 4.3,
    accountsPayable: 0.7, shortTermDebt: 0.3, accruedLiabilities: 0.3,
    totalCurrentLiabilities: 1.3, longTermDebt: 0.6, otherLiabilities: 0.1,
    totalLiabilities: 2.0, totalEquity: 2.3, totalLiabilitiesAndEquity: 4.3,
  },
};

// Cash Flow line items (in millions USD).
// Reconciles: NI + D&A + ΔWC = OCF; OCF + ICF + FCF = ΔCash.
// 2023: 1.1 − 0.3 − 0.7 = +0.1, prior cash 0.4 → 0.5 ✓
// 2022: 0.7 − 0.3 − 0.3 = +0.1, prior cash 0.3 → 0.4 ✓ (2021 ending implied)
const CASH_FLOW_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    netIncome: 1.2, depreciation: 0.2, changesInWorkingCapital: -0.3,
    operatingCashFlow: 1.1, capitalExpenditures: -0.3, acquisitions: 0,
    investingCashFlow: -0.3, debtIssuance: -0.1, dividends: -0.6,
    financingCashFlow: -0.7, netChangeInCash: 0.1,
  },
  '2022': {
    netIncome: 0.8, depreciation: 0.2, changesInWorkingCapital: -0.3,
    operatingCashFlow: 0.7, capitalExpenditures: -0.3, acquisitions: 0,
    investingCashFlow: -0.3, debtIssuance: -0.1, dividends: -0.2,
    financingCashFlow: -0.3, netChangeInCash: 0.1,
  },
};

export async function createSampleDeal(orgId: string, userId: string): Promise<string | null> {
  try {
    // 1. Create Company
    const { data: company, error: companyErr } = await supabase
      .from('Company')
      .insert({ ...WAGONER_COMPANY, organizationId: orgId })
      .select('id')
      .single();

    if (companyErr) throw companyErr;

    // 2. Create Deal
    const { data: deal, error: dealErr } = await supabase
      .from('Deal')
      .insert({
        ...WAGONER_DEAL,
        companyId: company.id,
        organizationId: orgId,
        assignedTo: userId,
      })
      .select('id')
      .single();

    if (dealErr) throw dealErr;

    // 3. Create VDR Folders
    const folderInserts = WAGONER_FOLDERS.map(f => ({
      ...f,
      dealId: deal.id,
      createdBy: userId,
    }));

    await supabase.from('Folder').insert(folderInserts);

    // 4. Create Financial Statements
    const statements: any[] = [];

    for (const [period, lineItems] of Object.entries(INCOME_STATEMENT_ITEMS)) {
      statements.push({
        dealId: deal.id,
        statementType: 'INCOME_STATEMENT',
        period,
        periodType: 'HISTORICAL',
        lineItems,
        currency: 'USD',
        unitScale: 'MILLIONS',
        extractionConfidence: 95,
        extractionSource: 'manual' as const,
        extractedAt: new Date().toISOString(),
        isActive: true,
      });
    }

    for (const [period, lineItems] of Object.entries(BALANCE_SHEET_ITEMS)) {
      statements.push({
        dealId: deal.id,
        statementType: 'BALANCE_SHEET',
        period,
        periodType: 'HISTORICAL',
        lineItems,
        currency: 'USD',
        unitScale: 'MILLIONS',
        extractionConfidence: 95,
        extractionSource: 'manual' as const,
        extractedAt: new Date().toISOString(),
        isActive: true,
      });
    }

    for (const [period, lineItems] of Object.entries(CASH_FLOW_ITEMS)) {
      statements.push({
        dealId: deal.id,
        statementType: 'CASH_FLOW',
        period,
        periodType: 'HISTORICAL',
        lineItems,
        currency: 'USD',
        unitScale: 'MILLIONS',
        extractionConfidence: 95,
        extractionSource: 'manual' as const,
        extractedAt: new Date().toISOString(),
        isActive: true,
      });
    }

    await supabase.from('FinancialStatement').insert(statements);

    // 5. Create Activities
    const activities = [
      {
        dealId: deal.id,
        type: 'DEAL_CREATED',
        title: 'Sample deal created',
        description: 'Wagoner Industrial Supply added as a sample deal to help you explore PE OS.',
        userId,
      },
      {
        dealId: deal.id,
        type: 'AI_EXTRACTION',
        title: 'Financial statements extracted',
        description: 'AI extracted 3 years of financials: Income Statement, Balance Sheet, and Cash Flow.',
        userId,
      },
    ];

    await supabase.from('Activity').insert(activities);

    log.info('Sample deal created for new org', { orgId, dealId: deal.id, company: 'Wagoner Industrial Supply' });
    return deal.id;
  } catch (error) {
    log.error('Failed to create sample deal', error, { orgId });
    return null;
  }
}
