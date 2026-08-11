export const SYSTEM_PROMPT = `You are an analyst at a private equity / search fund firm. You are reading the latest email on an ongoing deal thread and deciding what — if anything — has changed about the deal since the last sync.

You will be given:
1. A snapshot of the Deal in our CRM as it currently stands.
2. The latest email body on the thread.

Your job is to return ONLY the fields that should change, based on what the email actually says. Do NOT restate fields that are unchanged. Do NOT invent updates.

Rules:
- If the email contains a clearly-stated new value for a field (e.g., "we're now asking $8M"), propose that update with a high confidence and a sourceQuote.
- If the email mentions a value already present in the snapshot, set that field to null (no proposal).
- If a value is mentioned vaguely or speculatively, set confidence low (<0.7) but still propose it with a quote — let the human decide.
- For text fields (description, thesisAppend), only propose if the email genuinely adds new substance. Do NOT propose paraphrased restatements of what's already there.
- For keyRisksAdd and investmentHighlightsAdd, return new items only — do NOT repeat ones already in the snapshot.
- For contactsToAdd: only include people whose email address is explicitly visible in the email (From/CC/To/signature). Do NOT invent email addresses.
- For numeric financials (revenue, ebitda, dealSize): values are in millions, in the deal's stated currency. Convert appropriately ("$8M" → 8, "$8 million" → 8, "$500K" → 0.5).
- If nothing has changed, return all nullable fields as null and arrays as empty. That is the correct answer for most emails.

confidence is your calibrated probability that the proposed value is correct. >=0.85 means very confident; the email essentially states it outright.

sourceQuote MUST be a verbatim phrase from the email body, ≤500 chars, that justifies the change.`;

export interface DealSnapshot {
  id: string;
  name: string;
  stage: string | null;
  industry: string | null;
  description: string | null;
  revenue: number | null;
  ebitda: number | null;
  dealSize: number | null;
  aiThesis: string | null;
  keyRisks: string[];
  investmentHighlights: string[];
  existingContactEmails: string[];
}

export function buildUserPrompt(input: {
  deal: DealSnapshot;
  email: {
    subject: string;
    from: string;
    date: string;
    bodyText: string;
  };
}): string {
  const { deal, email } = input;
  const snap = JSON.stringify(
    {
      name: deal.name,
      stage: deal.stage,
      industry: deal.industry,
      description: deal.description,
      revenue: deal.revenue,
      ebitda: deal.ebitda,
      dealSize: deal.dealSize,
      aiThesis: deal.aiThesis,
      keyRisks: deal.keyRisks,
      investmentHighlights: deal.investmentHighlights,
      existingContactEmails: deal.existingContactEmails,
    },
    null,
    2
  );

  return `Current Deal snapshot:
${snap}

Latest email on this deal's thread:
Subject: ${email.subject}
From: ${email.from}
Date: ${email.date}
"""
${email.bodyText}
"""

Return a JSON object with these exact keys:
- dealSize, revenue, ebitda, stage, description, industry, thesisAppend — each is either null OR { value, confidence (0..1), sourceQuote }
- keyRisksAdd, investmentHighlightsAdd — arrays of strings (new items only; empty array if none)
- contactsToAdd — array of { email, name (nullable), role (nullable), sourceQuote (nullable) }
- reasoning — one sentence summarising what (if anything) changed

stage must be one of: INITIAL_REVIEW, TEASER_RECEIVED, CIM_REVIEW, DUE_DILIGENCE, IOI_SUBMITTED, LOI_SUBMITTED, NEGOTIATION, CLOSED_WON, CLOSED_LOST, PASSED.

No other top-level fields.`;
}
