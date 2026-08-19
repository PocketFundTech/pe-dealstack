import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

/**
 * Creates a fully-loaded Lukhtara sample deal for a new organization.
 * Includes: Company, Deal, VDR Folders, FinancialStatements, Activities.
 * Uses existing `tags` field with ['sample'] — no schema changes needed.
 */

const LUKHTARA_COMPANY = {
  name: 'Lukhtara Industries',
  industry: 'Manufacturing & Distribution',
  website: 'https://lukhtara.example.com',
  description: 'Diversified manufacturing company specializing in industrial components and distribution across South Asia. Strong revenue growth with expanding margins.',
};

const LUKHTARA_DEAL = {
  name: 'Lukhtara Industries — Acquisition',
  stage: 'DUE_DILIGENCE',
  status: 'ACTIVE',
  industry: 'Manufacturing & Distribution',
  description: 'Potential acquisition of Lukhtara Industries, a diversified manufacturer with strong regional presence. Company shows consistent revenue growth and improving margins across core segments.',
  aiThesis: 'Strong manufacturing base with expanding distribution network. Revenue growing at 15% CAGR with EBITDA margins improving from 18% to 22%. Key risks: customer concentration (top 5 = 45% revenue) and raw material price volatility.',
  revenue: 125.0,
  ebitda: 27.5,
  irrProjected: 22.5,
  mom: 2.8,
  dealSize: 185.0,
  icon: 'factory',
  priority: 'HIGH',
  tags: ['sample'],
};

const LUKHTARA_FOLDERS = [
  { name: 'Financials', description: 'Financial statements and models' },
  { name: 'Legal', description: 'Legal documents and agreements' },
  { name: 'Company Overview', description: 'Company presentations and background' },
];

// Income Statement line items (in millions USD)
const INCOME_STATEMENT_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    revenue: 125.0, costOfGoodsSold: 78.5, grossProfit: 46.5,
    sellingGeneralAdmin: 12.8, researchDevelopment: 3.2, depreciation: 4.5,
    operatingIncome: 26.0, interestExpense: 2.8, otherIncome: 1.3,
    pretaxIncome: 24.5, incomeTax: 6.1, netIncome: 18.4,
  },
  '2022': {
    revenue: 108.0, costOfGoodsSold: 69.1, grossProfit: 38.9,
    sellingGeneralAdmin: 11.5, researchDevelopment: 2.9, depreciation: 4.0,
    operatingIncome: 20.5, interestExpense: 3.1, otherIncome: 0.8,
    pretaxIncome: 18.2, incomeTax: 4.6, netIncome: 13.6,
  },
  '2021': {
    revenue: 92.0, costOfGoodsSold: 60.7, grossProfit: 31.3,
    sellingGeneralAdmin: 10.2, researchDevelopment: 2.5, depreciation: 3.6,
    operatingIncome: 15.0, interestExpense: 3.4, otherIncome: 0.5,
    pretaxIncome: 12.1, incomeTax: 3.0, netIncome: 9.1,
  },
};

const BALANCE_SHEET_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    cash: 18.2, accountsReceivable: 22.5, inventory: 15.8, otherCurrentAssets: 3.5,
    totalCurrentAssets: 60.0, propertyPlantEquipment: 45.0, intangibleAssets: 8.5,
    goodwill: 12.0, otherNonCurrentAssets: 4.5, totalAssets: 130.0,
    accountsPayable: 14.2, shortTermDebt: 8.0, accruedLiabilities: 6.8,
    totalCurrentLiabilities: 29.0, longTermDebt: 32.0, otherLiabilities: 5.0,
    totalLiabilities: 66.0, totalEquity: 64.0, totalLiabilitiesAndEquity: 130.0,
  },
  '2022': {
    cash: 14.5, accountsReceivable: 19.8, inventory: 14.2, otherCurrentAssets: 3.0,
    totalCurrentAssets: 51.5, propertyPlantEquipment: 41.0, intangibleAssets: 9.0,
    goodwill: 12.0, otherNonCurrentAssets: 4.0, totalAssets: 117.5,
    accountsPayable: 12.5, shortTermDebt: 7.5, accruedLiabilities: 6.0,
    totalCurrentLiabilities: 26.0, longTermDebt: 35.0, otherLiabilities: 4.5,
    totalLiabilities: 65.5, totalEquity: 52.0, totalLiabilitiesAndEquity: 117.5,
  },
};

const CASH_FLOW_ITEMS: Record<string, Record<string, number>> = {
  '2023': {
    netIncome: 18.4, depreciation: 4.5, changesInWorkingCapital: -3.2,
    operatingCashFlow: 19.7, capitalExpenditures: -8.5, acquisitions: 0,
    investingCashFlow: -8.5, debtIssuance: -3.0, dividends: -4.5,
    financingCashFlow: -7.5, netChangeInCash: 3.7,
  },
  '2022': {
    netIncome: 13.6, depreciation: 4.0, changesInWorkingCapital: -2.1,
    operatingCashFlow: 15.5, capitalExpenditures: -7.0, acquisitions: 0,
    investingCashFlow: -7.0, debtIssuance: 2.0, dividends: -3.5,
    financingCashFlow: -1.5, netChangeInCash: 7.0,
  },
};

export async function createSampleDeal(orgId: string, userId: string): Promise<string | null> {
  try {
    // 1. Create Company
    const { data: company, error: companyErr } = await supabase
      .from('Company')
      .insert({ ...LUKHTARA_COMPANY, organizationId: orgId })
      .select('id')
      .single();

    if (companyErr) throw companyErr;

    // 2. Create Deal
    const { data: deal, error: dealErr } = await supabase
      .from('Deal')
      .insert({
        ...LUKHTARA_DEAL,
        companyId: company.id,
        organizationId: orgId,
        assignedTo: userId,
      })
      .select('id')
      .single();

    if (dealErr) throw dealErr;

    // 3. Create VDR Folders
    const folderInserts = LUKHTARA_FOLDERS.map(f => ({
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
        description: 'Lukhtara Industries added as a sample deal to help you explore Avise.',
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

    log.info('Sample deal created for new org', { orgId, dealId: deal.id, company: 'Lukhtara Industries' });
    return deal.id;
  } catch (error) {
    log.error('Failed to create sample deal', error, { orgId });
    return null;
  }
}
