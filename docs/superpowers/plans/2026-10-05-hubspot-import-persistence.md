# HubSpot Import Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a running or just-finished HubSpot import visible again after a page reload/new tab, instead of going dark with no indication anything happened.

**Architecture:** One new read-only backend endpoint (`GET /integrations/hubspot/import/latest`) returns the org's most recent `ImportJob`. The frontend `HubSpotPanel` calls it on mount: if the job is still `running` it re-populates the progress card and resumes driving the existing poll + `/continue` loop (same mechanism `startImport()` already uses, refactored into shared helpers); if the job is terminal, its final counts render as a persistent "last import" summary.

**Tech Stack:** Express + Supabase (`apps/api`), Next.js/React + Vitest/RTL (`apps/web-next`).

---

### Task 1: Backend — `GET /integrations/hubspot/import/latest`

**Files:**
- Modify: `apps/api/src/routes/hubspot-import.ts:216` (insert new route immediately before the existing `GET /import/:id` route — it must come first, or Express would match `/import/latest` as `:id = "latest"`)
- Modify: `apps/api/tests/hubspot-routes.test.ts` (extend the shared `chain()` helper, add new tests)

- [ ] **Step 1: Extend the test file's `chain()` helper to support `.order()`/`.limit()`**

The new route calls `.order(...).limit(1).maybeSingle()`, which the existing mock chain doesn't stub. Edit `apps/api/tests/hubspot-routes.test.ts`:

```ts
const chain = (overrides: Record<string, any> = {}) => ({
  select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }), ...overrides,
});
```

(This only adds two stub methods that return `this` — no existing test calls them, so nothing else changes behavior.)

- [ ] **Step 2: Write the failing tests**

Add this new `describe` block at the end of `apps/api/tests/hubspot-routes.test.ts`, before the final closing of the file:

```ts
describe('GET /import/latest', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the most recent job for the org', async () => {
    const job = { id: 'job-42', status: 'running', currentObject: 'contacts', objectCounts: {}, error: null };
    const maybeSingleMock = vi.fn().mockResolvedValueOnce({ data: job });
    mockSupabase.from.mockReturnValue(chain({ maybeSingle: maybeSingleMock }));

    const res = await request(await buildApp()).get('/api/integrations/hubspot/import/latest');

    expect(res.status).toBe(200);
    expect(res.body.job).toEqual(job);
  });

  it('returns job: null when the org has never run an import', async () => {
    mockSupabase.from.mockReturnValue(chain({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }));

    const res = await request(await buildApp()).get('/api/integrations/hubspot/import/latest');

    expect(res.status).toBe(200);
    expect(res.body.job).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: FAIL — `GET /api/integrations/hubspot/import/latest` doesn't exist yet, so the request falls through to the `GET /import/:id` route instead and returns 404 (or the two new tests otherwise don't match `res.body.job`).

- [ ] **Step 4: Implement the route**

In `apps/api/src/routes/hubspot-import.ts`, insert this immediately before the `// GET /import/:id → status` comment (currently line 216):

```ts
// GET /import/latest → most recent HubSpot ImportJob for the org, or null.
// Lets the client re-hydrate progress/history after a reload — the job id
// isn't known client-side until a job already exists, so this is the only
// way to find one. Must be registered before GET /import/:id, or Express
// would match "latest" as the :id param.
router.get('/import/latest', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data } = await supabase
    .from('ImportJob').select('*')
    .eq('organizationId', orgId).eq('source', 'hubspot')
    .order('startedAt', { ascending: false }).limit(1).maybeSingle();
  res.json({ job: data ?? null });
});

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run tests/hubspot-routes.test.ts`
Expected: PASS — all tests in the file, including the 2 new ones.

- [ ] **Step 6: Run the full API test suite to check for regressions**

Run: `cd apps/api && npx vitest run`
Expected: Same pass count as before this change, plus the 2 new tests (no new failures).

- [ ] **Step 7: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/api/src/routes/hubspot-import.ts apps/api/tests/hubspot-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(hubspot): add GET /import/latest to re-hydrate import status

Lets the frontend recover a running or just-finished import's state
after a page reload — previously only the tab that started it ever
saw progress or results.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — resume/show on mount

**Files:**
- Modify: `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx:260` (export `HubSpotPanel`, refactor polling/continue into shared helpers, add mount-resume effect)
- Create: `apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx`

- [ ] **Step 1: Export `HubSpotPanel` so it's directly testable**

In `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`, change line 260 from:

```ts
function HubSpotPanel({ onToast }: HubSpotPanelProps) {
```

to:

```ts
export function HubSpotPanel({ onToast }: HubSpotPanelProps) {
```

- [ ] **Step 2: Write the failing test**

Create `apps/web-next/src/app/(app)/settings/HubSpotPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {},
}));

import { HubSpotPanel } from "./IntegrationsSection";

const RUNNING_JOB = {
  id: "job-resume-1",
  status: "running",
  currentObject: "contacts",
  objectCounts: {
    companies: { processed: 3837, created: 1539, updated: 1846, failed: 452 },
    contacts: { processed: 600, created: 355, updated: 129, failed: 116 },
  },
  error: null,
};

const COMPLETED_JOB = {
  id: "job-done-1",
  status: "completed",
  currentObject: null,
  objectCounts: {
    companies: { processed: 10, created: 10, updated: 0, failed: 0 },
  },
  error: null,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe("HubSpotPanel", () => {
  it("re-hydrates a running job's progress card on mount, without creating a new job", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: RUNNING_JOB });
      if (path === "/integrations/hubspot/import/job-resume-1") return Promise.resolve(RUNNING_JOB);
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/import/job-resume-1/continue") return Promise.resolve({ more: false });
      throw new Error(`unexpected POST ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    expect(await screen.findByText(/syncing contacts/i)).toBeInTheDocument();
    // Never re-created the job — only drove the existing one.
    expect(post).not.toHaveBeenCalledWith("/integrations/hubspot/import", expect.anything());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/integrations/hubspot/import/job-resume-1/continue", { mode: "fill" }),
    );
  });

  it("shows a completed job's final counts as a persistent summary on mount", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: COMPLETED_JOB });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    // Match the full "Status: completed" text, not just /completed/i — that
    // regex alone would also match the inner <span>{job.status}</span>,
    // which RTL treats as two separate matches and throws on.
    expect(await screen.findByText(/status:\s*completed/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows nothing extra when the org has never run an import", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/integrations/hubspot/connect") return Promise.resolve({ connected: true });
      if (path === "/integrations/hubspot/import/latest") return Promise.resolve({ job: null });
      throw new Error(`unexpected GET ${path}`);
    });

    render(<HubSpotPanel onToast={() => {}} />);

    await screen.findByText(/HubSpot connected/i);
    expect(screen.queryByText(/status:/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/app/\(app\)/settings/HubSpotPanel.test.tsx`
Expected: FAIL — `HubSpotPanel` isn't exported from a module resolvable this way yet / the mount effect doesn't call `/integrations/hubspot/import/latest` yet, so `findByText(/syncing contacts/i)` times out.

- [ ] **Step 4: Refactor `HubSpotPanel` — shared polling/continue helpers + mount-resume effect**

In `apps/web-next/src/app/(app)/settings/IntegrationsSection.tsx`, replace the block from line 269 (`useEffect(() => {`) through line 276 (`}, []);`) — i.e. the current mount effect — with:

```ts
  // Refreshes `job` from the server and stops polling once it reaches a
  // terminal state. Shared by the manual-start flow and the mount-resume
  // flow below so both drive the exact same completion/toast logic.
  const pollJobOnce = useCallback(async (jobId: string) => {
    const j = await api.get<HubSpotImportJob>(`/integrations/hubspot/import/${jobId}`);
    setJob(j);
    if (POLL_TERMINAL.has(j.status) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      if (j.status === "completed") onToast("HubSpot import finished", "success");
      else onToast(`Import ended with status: ${j.status}`, "error");
    }
    return j;
  }, [onToast]);

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) return;
    void pollJobOnce(jobId);
    pollRef.current = setInterval(() => {
      pollJobOnce(jobId).catch(console.warn);
    }, 2000);
  }, [pollJobOnce]);

  // Keeps calling /continue until the server says there's nothing left.
  // Used both right after starting a brand-new import and when resuming one
  // found already `running` on mount (reload / new tab).
  const driveContinue = useCallback(async (jobId: string, mode: "fill" | "refresh", initialMore: boolean) => {
    let hasMore = initialMore;
    let rounds = 0;
    while (hasMore && rounds < MAX_CONTINUE_ROUNDS) {
      const next = await api.post<{ more: boolean }>(`/integrations/hubspot/import/${jobId}/continue`, { mode });
      hasMore = next.more;
      rounds += 1;
    }
    return hasMore;
  }, []);

  useEffect(() => {
    api.get<{ connected: boolean }>("/integrations/hubspot/connect")
      .then((r) => setConnected(r.connected))
      .catch(() => {});

    // Re-hydrate the progress card / "last import" summary after a reload —
    // without this, a running job becomes invisible the moment the tab that
    // started it closes or refreshes, even though it's still working
    // server-side (confirmed 2026-10-05: a job kept advancing for hours
    // with zero browser tabs driving it visibly).
    api.get<{ job: HubSpotImportJob | null }>("/integrations/hubspot/import/latest")
      .then(async (r) => {
        if (!r.job) return;
        setJob(r.job);
        if (r.job.status === "running") {
          const mode: "fill" | "refresh" = overwrite ? "refresh" : "fill";
          startPolling(r.job.id);
          const hasMore = await driveContinue(r.job.id, mode, true);
          if (hasMore) {
            setError("Import is taking unusually long. Click \"Import from HubSpot\" again to resume where it left off.");
          }
        }
      })
      .catch(() => {});

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // Intentionally mount-only: `overwrite` reflects the checkbox's default
    // state at load time, not a value this effect should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 5: Replace `startImport()` to reuse the new shared helpers**

Replace the existing `startImport` function (currently lines 312–370, from `async function startImport() {` through its closing `}`) with:

```ts
  async function startImport() {
    if (pollRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const mode: "fill" | "refresh" = overwrite ? "refresh" : "fill";
      const { jobId, more } = await api.post<{ jobId: string; more: boolean }>(
        "/integrations/hubspot/import",
        { mode },
      );

      startPolling(jobId);

      const hasMore = await driveContinue(jobId, mode, more);
      if (hasMore) {
        // Far beyond any realistic import size — stop rather than hammer the
        // server. The job is still resumable: clicking Import again picks it up.
        setError("Import is taking unusually long. Click \"Import from HubSpot\" again to resume where it left off.");
      }
      // Final refresh so the card reflects the terminal state immediately
      // rather than waiting for the next poll tick.
      await pollJobOnce(jobId).catch(console.warn);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        "Failed to start import";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web-next && npx vitest run "src/app/(app)/settings/HubSpotPanel.test.tsx"`
Expected: PASS — all 3 tests.

- [ ] **Step 7: Type-check and run the full web-next test suite**

Run: `cd apps/web-next && npx tsc --noEmit`
Expected: No errors.

Run: `cd apps/web-next && npx vitest run`
Expected: Same pass count as before this change, plus the 3 new tests (no new failures).

- [ ] **Step 8: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add apps/web-next/src/app/\(app\)/settings/IntegrationsSection.tsx apps/web-next/src/app/\(app\)/settings/HubSpotPanel.test.tsx
git commit -m "$(cat <<'EOF'
fix(hubspot): resume/show import progress after a page reload

HubSpotPanel only checked connection status on mount — a running
import's progress card and continue-driving loop lived purely in
that one tab's React state, so reloading or revisiting the page
showed a bare "Import from HubSpot" button with zero indication
anything was happening, even while the job kept working server-side.

Now fetches GET /import/latest on mount: resumes polling + driving a
still-running job, or renders a completed/failed job's final counts
as a persistent summary. Shared the poll/continue logic between
startImport() and the new mount-resume path instead of duplicating it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Progress log + final verification

**Files:**
- Modify: `PROGRESS.md` (append a new session entry — IST timestamp, per house convention)

- [ ] **Step 1: Determine current IST timestamp**

Run: `TZ=Asia/Kolkata date "+%B %d, %Y — %H:%M IST"`

- [ ] **Step 2: Append a new entry to `PROGRESS.md`**

Insert a new `### Session <next-number> — <date>` section at the top of the log (immediately after the `---` following the file header, above the most recent existing session), following the existing format. Use the actual next session number (check the most recent `### Session N` heading in the file and increment) and the timestamp from Step 1. Content:

```markdown
### Session <N> — October 5, 2026

#### Timestamp: <timestamp from Step 1>

#### Goal: A live HubSpot import (thousands of companies/contacts) went invisible in the UI after a page reload, with no way to tell whether it was still running or see what a past import had done.

#### Root cause

`HubSpotPanel` (`apps/web-next/.../settings/IntegrationsSection.tsx`) only ever checked
`GET /integrations/hubspot/connect` on mount — it never fetched the org's `ImportJob`
history. The progress card, and the client-side loop that drives `/continue` to actually
advance the import past each ~3.5-minute serverless request window, existed only in the
one browser tab's React state. Confirmed via direct read of the `ImportJob` row that the
import kept progressing for hours server-side with zero visible UI state.

#### Fix

- `GET /api/integrations/hubspot/import/latest` (new) — returns the org's most recent
  HubSpot `ImportJob`, or `null`.
- `HubSpotPanel` now calls it on mount: a `running` job resumes polling + the `/continue`
  drive loop; a terminal job's final per-object counts render as a persistent "last
  import" summary. Refactored the poll/continue logic (previously only inline in
  `startImport()`) into shared `pollJobOnce`/`startPolling`/`driveContinue` helpers.
- Tests: 2 new backend tests (`hubspot-routes.test.ts`), 3 new frontend tests
  (`HubSpotPanel.test.tsx`). Full API + web-next suites green, `tsc --noEmit` clean.

#### Known follow-ups (not in this fix)

- No dedicated "Companies" page exists in `apps/web-next` — imported Company records
  (HubSpot auto-creates one per contact/website domain, so counts routinely run 4-10x
  actual Deal counts) are only visible if linked to a Deal. `GET /api/companies` already
  exists and is unused by the frontend. Discussed with founder as a separate follow-up,
  not built yet.
- Per-record import failures (companies/contacts failure rate was running 12-20% on this
  org's import) are only logged server-side (`[hubspot] record {id} failed: ...`), not
  surfaced anywhere in the UI or stored on the job row. Worth adding structured failure
  reasons if this rate turns out to be a recurring pattern rather than one portal's data
  quality.

---

```

- [ ] **Step 3: Commit**

```bash
cd "/Users/ganesh/AI CRM"
git add PROGRESS.md
git commit -m "$(cat <<'EOF'
docs(progress): log HubSpot import visibility fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Final full-repo verification**

Run: `cd apps/api && npx vitest run`
Expected: All green, same or higher count than Task 1 Step 6.

Run: `cd apps/web-next && npx vitest run && npx tsc --noEmit`
Expected: All green, same or higher count than Task 2 Step 7, no type errors.
