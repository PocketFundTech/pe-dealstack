// ---------------------------------------------------------------------------
// duplicateCheck — the client half of the two-step duplicate check on deal
// intake (testers: "duplicate deals still get created and the app doesn't
// flag it before").
//
// When a request could create a deal, the client sends `checkDuplicates:
// true`. If the server finds a live deal that looks like the same company it
// creates nothing and returns `duplicateCheck` + `extractionToken`. We ask
// the user, then resend the same request with their choice — `dealId` (add to
// that deal) or `forceCreate` (new deal) — plus the token, so the server
// reuses its AI read instead of running it again.
// ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  id: string;
  name: string;
  companyName: string | null;
  /** "exact" = same name once case / punctuation / "Inc." are ignored; "similar" = acronym, extra words, typo. */
  reason: "exact" | "similar";
}

export interface DuplicateCheck {
  candidates: DuplicateCandidate[];
  extractedCompanyName: string | null;
}

export type DuplicateDecision =
  | { action: "add"; dealId: string; dealName: string }
  | { action: "create" }
  | { action: "cancel" };

/** Shows the "This looks like a deal you already have" modal and resolves with the user's choice. */
export type AskDuplicate = (check: DuplicateCheck) => Promise<DuplicateDecision>;

/** Extra body fields for a request: the first try, or the resend after a decision. */
export type DuplicateExtra =
  | { checkDuplicates: true }
  | { dealId: string; extractionToken?: string }
  | { forceCreate: true; extractionToken?: string };

interface MaybeDuplicateResponse {
  duplicateCheck?: DuplicateCheck;
  extractionToken?: string;
}

export type DuplicateCheckedResult<T> =
  | { cancelled: true }
  | { cancelled: false; data: T; decision: DuplicateDecision | null };

/**
 * Run `send` with `checkDuplicates: true`; if the server asks, get the user's
 * decision from `ask` and run `send` again with it. `ask` absent = old
 * behaviour (one request, no check).
 */
export async function sendWithDuplicateCheck<T extends MaybeDuplicateResponse>(
  send: (extra: DuplicateExtra | Record<string, never>) => Promise<T>,
  ask: AskDuplicate | undefined,
): Promise<DuplicateCheckedResult<T>> {
  if (!ask) return { cancelled: false, data: await send({}), decision: null };
  const first = await send({ checkDuplicates: true });
  if (!first.duplicateCheck || first.duplicateCheck.candidates.length === 0) {
    return { cancelled: false, data: first, decision: null };
  }
  const decision = await ask(first.duplicateCheck);
  if (decision.action === "cancel") return { cancelled: true };
  const token = first.extractionToken ? { extractionToken: first.extractionToken } : {};
  const data = await send(
    decision.action === "add" ? { dealId: decision.dealId, ...token } : { forceCreate: true, ...token },
  );
  return { cancelled: false, data, decision };
}
