// ─── Private Circle CSV import — thin wrapper over outreachCsvImport.ts ────
//
// Private Circle has no API yet (enterprise access request still pending)
// and its own CSV export caps out around 100-200 rows. Per this feature's
// source planning doc, the current process is: a human sources/filters
// inside Private Circle's own UI (that stays human-driven — this module
// does NOT touch sourcing), exports a CSV, then today retypes the rows
// into Reply.io by hand. This module automates exactly that retyping step.
//
// De-dupe/clean/import logic lives in services/outreachCsvImport.ts (shared
// with outreachClayCsvImport.ts, since a Clay-exported CSV needs identical
// handling once its own headers are mapped to our row shape).
//
// ─── Expected CSV column mapping (OUR contract — NOT a confirmed Private
//     Circle export field dictionary; no real PC export sample was
//     available while building this) ──────────────────────────────────
//
// Header matching is case/whitespace/punctuation-insensitive and accepts
// any of a small set of plausible variants per field, listed below. Whoever
// runs the FIRST real Private Circle import should compare PC's actual
// column headers against this list and extend PRIVATE_CIRCLE_COLUMN_MAP if
// they don't match — the header variants here are a best guess at Private
// Circle's likely export wording, not a verified spec.
//
//   Row field      Accepted header variants (normalized)
//   -----------    --------------------------------------------------
//   companyName    Company Name, Company, Organisation Name,
//                  Organization Name                          (required)
//   cin            CIN, Corporate Identification Number
//   contactName    Decision Maker, Decision Maker Name, Contact Name,
//                  Contact Person, Key Contact, Point Of Contact
//   title          Designation, Title, Role, Job Title
//   email          Email, Email Address, Decision Maker Email
//   phone          Phone, Phone Number, Mobile, Contact Number
//   linkedinUrl    LinkedIn, LinkedIn URL, LinkedIn Profile
//   location       Location, City, Address, HQ Location
//   employeeSize   Employee Count, Company Size, Employees, Headcount
//   industry       Industry, Sector
//   sourceUrl      Profile URL, Source URL, Private Circle URL,
//                  Record URL
//
// A row with no resolvable companyName is dropped before it reaches the
// cleaner/import engine (companyName is required by
// outreachContactImport.ts's row schema) and counted as "received" but not
// created/updated/flagged, same as any other row that fails validation.

import { importContactsCsv, type CsvColumnMap, type CsvImportResult } from './outreachCsvImport.js';

export type { CsvImportResult as PrivateCircleImportResult } from './outreachCsvImport.js';

const PRIVATE_CIRCLE_COLUMN_MAP: CsvColumnMap = {
  companyName: ['Company Name', 'Company', 'Organisation Name', 'Organization Name'],
  cin: ['CIN', 'Corporate Identification Number'],
  contactName: ['Decision Maker', 'Decision Maker Name', 'Contact Name', 'Contact Person', 'Key Contact', 'Point Of Contact'],
  title: ['Designation', 'Title', 'Role', 'Job Title'],
  email: ['Email', 'Email Address', 'Decision Maker Email'],
  phone: ['Phone', 'Phone Number', 'Mobile', 'Contact Number'],
  linkedinUrl: ['LinkedIn', 'LinkedIn URL', 'LinkedIn Profile'],
  location: ['Location', 'City', 'Address', 'HQ Location'],
  employeeSize: ['Employee Count', 'Company Size', 'Employees', 'Headcount'],
  industry: ['Industry', 'Sector'],
  sourceUrl: ['Profile URL', 'Source URL', 'Private Circle URL', 'Record URL'],
};

export async function importPrivateCircleCsv(orgId: string, rows: Record<string, string>[]): Promise<CsvImportResult> {
  return importContactsCsv(orgId, rows, {
    sourceProvider: 'private_circle',
    touchChannel: 'private_circle_import',
    columnMap: PRIVATE_CIRCLE_COLUMN_MAP,
    sourceLabel: 'Private Circle',
  });
}
