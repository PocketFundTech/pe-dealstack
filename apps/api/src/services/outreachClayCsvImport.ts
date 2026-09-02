// ─── Clay CSV import — thin wrapper over outreachCsvImport.ts ─────────────
//
// Workaround for Clay's real-time webhook push being gated behind a paid
// plan upgrade (Starter -> Launch, confirmed in Clay's own UI while
// building this): CSV export is available on every plan. A human still
// does the filtering/sourcing inside Clay's own table UI (unchanged, same
// as the webhook path would have been) — this just replaces "Clay pushes
// automatically" with "export the table, upload it here," which the shared
// de-dupe/clean/enrich engine can't tell apart from any other CSV source.
// If/when the Clay plan is upgraded, outreach-clay-import-webhook.ts (the
// real-time push path) is already built and can be used instead — nothing
// about this module needs to change either way, they both feed the same
// shared engine.
//
// ─── Expected CSV column mapping (OUR contract — Clay tables are
//     user-configured, so column names vary per workspace; this is a
//     best-guess set of common naming patterns, not a fixed spec) ─────────
//
//   Row field      Accepted header variants (normalized)
//   -----------    --------------------------------------------------
//   companyName    Company Name, Company, Company / Organization,
//                  Business Name                              (required)
//   cin            CIN, Corporate Identification Number
//   contactName    Full Name, Contact Name, Name, Person Name,
//                  Decision Maker
//   title          Title, Job Title, Designation, Role
//   email          Email, Work Email, Email Address, Business Email
//   phone          Phone, Phone Number, Mobile Phone, Mobile
//   linkedinUrl    LinkedIn, LinkedIn URL, Person LinkedIn URL,
//                  LinkedIn Profile
//   location       Location, City, HQ Location, Company Location
//   employeeSize   Employee Count, Company Size, # Employees, Headcount
//   industry       Industry, Company Industry, Sector
//   sourceUrl      Source, Source URL, Record URL, Clay Row URL
//
// Whoever runs the FIRST real Clay CSV import should compare the actual
// exported headers against this list and extend CLAY_CSV_COLUMN_MAP if
// they don't match.

import { importContactsCsv, type CsvColumnMap, type CsvImportResult } from './outreachCsvImport.js';

export type { CsvImportResult as ClayCsvImportResult } from './outreachCsvImport.js';

const CLAY_CSV_COLUMN_MAP: CsvColumnMap = {
  companyName: ['Company Name', 'Company', 'Company / Organization', 'Business Name'],
  cin: ['CIN', 'Corporate Identification Number'],
  contactName: ['Full Name', 'Contact Name', 'Name', 'Person Name', 'Decision Maker'],
  title: ['Title', 'Job Title', 'Designation', 'Role'],
  email: ['Email', 'Work Email', 'Email Address', 'Business Email'],
  phone: ['Phone', 'Phone Number', 'Mobile Phone', 'Mobile'],
  linkedinUrl: ['LinkedIn', 'LinkedIn URL', 'Person LinkedIn URL', 'LinkedIn Profile'],
  location: ['Location', 'City', 'HQ Location', 'Company Location'],
  employeeSize: ['Employee Count', 'Company Size', '# Employees', 'Headcount'],
  industry: ['Industry', 'Company Industry', 'Sector'],
  sourceUrl: ['Source', 'Source URL', 'Record URL', 'Clay Row URL'],
};

export async function importClayCsv(orgId: string, rows: Record<string, string>[]): Promise<CsvImportResult> {
  return importContactsCsv(orgId, rows, {
    sourceProvider: 'clay',
    touchChannel: 'clay_import',
    columnMap: CLAY_CSV_COLUMN_MAP,
    sourceLabel: 'Clay',
  });
}
