// ─── Firm NDA playbook ────────────────────────────────────────────
// The firm's standing position on each NDA clause. Stored at
// Organization.settings.ndaPlaybook — the same settings-JSON pattern as
// dealCriteria (routes/organization-criteria.ts), so no migration.
//
// The defaults below matter more than they look: they're what makes the
// feature useful on day one, before anyone has configured anything. They
// encode ordinary buy-side market positions for a lower-middle-market
// financial buyer — deliberately mainstream, because a default that
// over-reaches would train users to ignore the flags.
//
// These are drafting defaults, not legal advice; the UI says so, and every
// position is editable.

import { z } from 'zod';

export const ndaClausePositionSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  ourPosition: z.string().min(1).max(2000),
  acceptable: z.string().max(2000).optional(),
  dealBreaker: z.boolean().default(false),
  fallbackLanguage: z.string().max(4000).optional(),
});

export const ndaPlaybookSchema = z.object({
  positions: z.array(ndaClausePositionSchema).max(40).default([]),
  generalNotes: z.string().max(4000).default(''),
  updatedAt: z.string().optional(),
});

export type NdaClausePosition = z.infer<typeof ndaClausePositionSchema>;
export type NdaPlaybook = z.infer<typeof ndaPlaybookSchema>;

export const DEFAULT_NDA_PLAYBOOK: NdaPlaybook = {
  generalNotes:
    'Buy-side financial buyer reviewing a broker or seller NDA. We are evaluating an acquisition, not entering a commercial relationship, so obligations should be mutual where practical and must never restrict ordinary investing activity.',
  positions: [
    {
      key: 'term',
      label: 'Term of agreement',
      ourPosition: 'Two years from the date of signature.',
      acceptable: '18 months to 3 years.',
      dealBreaker: false,
      fallbackLanguage:
        'This Agreement shall terminate on the second (2nd) anniversary of the Effective Date.',
    },
    {
      key: 'confidentiality_period',
      label: 'Confidentiality survival period',
      ourPosition: 'Confidentiality obligations survive two years after termination.',
      acceptable: 'Up to 3 years; perpetual only for trade secrets.',
      dealBreaker: false,
    },
    {
      key: 'definition_of_confidential_info',
      label: 'Definition of Confidential Information',
      ourPosition:
        'Limited to information marked confidential or that a reasonable person would understand to be confidential, with standard carve-outs (already known, independently developed, publicly available, lawfully received from a third party).',
      acceptable: 'Any definition carrying the four standard carve-outs.',
      dealBreaker: false,
    },
    {
      key: 'permitted_disclosures',
      label: 'Permitted disclosures',
      ourPosition:
        'We may share with affiliates, employees, advisors, lenders, and prospective financing sources on a need-to-know basis, provided they are bound by equivalent confidentiality.',
      acceptable: 'Any formulation that includes financing sources and professional advisors.',
      dealBreaker: true,
      fallbackLanguage:
        'The Receiving Party may disclose Confidential Information to its affiliates, officers, employees, agents, professional advisors, actual and prospective debt and equity financing sources, in each case on a need-to-know basis and subject to confidentiality obligations no less restrictive than those set out herein.',
    },
    {
      key: 'non_solicit_employees',
      label: 'Employee non-solicitation',
      ourPosition:
        'Twelve months, limited to employees we actually met or learned of through this process, with carve-outs for general advertising and unsolicited applications.',
      acceptable: 'Up to 24 months if the general-advertising carve-out is present.',
      dealBreaker: false,
      fallbackLanguage:
        'Nothing herein shall prevent the Receiving Party from (i) making general solicitations for employment not specifically directed at any employee of the Disclosing Party, or (ii) hiring any person who responds to such a general solicitation or who approaches the Receiving Party on an unsolicited basis.',
    },
    {
      key: 'non_circumvent',
      label: 'Non-circumvention',
      ourPosition:
        'Acceptable only if narrowly scoped to this specific target and time-limited to the term of the agreement.',
      acceptable: 'Target-specific and time-limited.',
      dealBreaker: false,
    },
    {
      key: 'residuals',
      label: 'Residual knowledge',
      ourPosition:
        'We want a residuals clause permitting use of general knowledge, skill and experience retained in unaided memory.',
      acceptable: 'Silence is acceptable; an express prohibition on residuals is not.',
      dealBreaker: false,
    },
    {
      key: 'return_or_destruction',
      label: 'Return or destruction of materials',
      ourPosition:
        'Destruction (not physical return) on request, with an express carve-out for archival and automatic electronic backups and for copies required by law or internal compliance policy.',
      acceptable: 'Any clause preserving the backup/legal-retention carve-out.',
      dealBreaker: false,
      fallbackLanguage:
        'The Receiving Party may retain (i) copies of Confidential Information stored on routine electronic backup systems and (ii) one copy required to comply with applicable law, regulation or internal document-retention policy, in each case subject to continuing confidentiality obligations.',
    },
    {
      key: 'no_obligation',
      label: 'No obligation to proceed',
      ourPosition:
        'Express statement that neither party is obliged to proceed with, or continue, discussions or any transaction.',
      acceptable: 'Any express no-obligation language.',
      dealBreaker: false,
    },
    {
      key: 'standstill',
      label: 'Standstill',
      ourPosition:
        'No standstill. We will not accept restrictions on acquiring securities or making proposals; this is a private-company process.',
      acceptable: 'Absence of the clause.',
      dealBreaker: true,
    },
    {
      key: 'exclusivity',
      label: 'Exclusivity / no-shop',
      ourPosition:
        'An NDA is not the place for exclusivity. Any no-shop or exclusivity obligation belongs in an LOI, if anywhere.',
      acceptable: 'Absence of the clause.',
      dealBreaker: true,
    },
    {
      key: 'governing_law',
      label: 'Governing law and jurisdiction',
      ourPosition:
        'Delaware or the seller\'s home state; courts of that state. Flag any foreign governing law or mandatory arbitration seat.',
      acceptable: 'Any US state.',
      dealBreaker: false,
    },
    {
      key: 'remedies_injunctive',
      label: 'Remedies / injunctive relief',
      ourPosition:
        'Injunctive relief is acceptable. Liquidated damages, penalty clauses, and one-sided fee-shifting are not.',
      acceptable: 'Injunctive relief plus mutual fee-shifting or silence on fees.',
      dealBreaker: false,
    },
    {
      key: 'assignment',
      label: 'Assignment',
      ourPosition:
        'We must be able to assign to an affiliate or an acquisition vehicle formed for this transaction.',
      acceptable: 'Assignment to affiliates permitted.',
      dealBreaker: false,
    },
    {
      key: 'notice',
      label: 'Compelled disclosure',
      ourPosition:
        'If legally compelled to disclose, we give prompt notice where lawful and cooperate with protective orders — but disclosure itself must not be a breach.',
      acceptable: 'Any clause permitting legally compelled disclosure.',
      dealBreaker: false,
    },
  ],
};
