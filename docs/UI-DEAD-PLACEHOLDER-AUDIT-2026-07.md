# UI Audit — Dead Placeholders & Customization Gaps

**Date:** 2026-07-04
**Scope:** Full `apps/web-next` frontend on deployed `main`, swept by 6 parallel agents (dashboard/global, memo builder, data room, AI/analysis, integrations/settings, deals/contacts/onboarding). Every reported control's handler was traced to confirm it's actually dead.

**Two dominant themes:**
1. **Controls that look functional but silently do nothing** — the most damaging, because they mislead users. Fix these first.
2. **Customization gaps** — the app hardcodes things every PE firm runs differently (pipeline stages, contact types, memo structure, fund thresholds, currency). A real multi-tenant product-maturity gap.

_Branding note:_ the product is "Pocket Fund" (domain `lmmos.ai`, `pocketfund.org` emails) but some code still says "PE OS" (e.g. TOTP issuer) — worth a global sweep.

---

## A. Broken / dead controls that mislead users (fix first)

| # | Sev | Where | Problem |
|---|-----|-------|---------|
| A1 | HIGH | `templates/page.tsx:206`, `memo-builder/page.tsx:71` | **"Use Template" is broken.** Navigates to `/memo-builder?templateId=…` but the builder never reads `templateId` — user lands on the empty memo list, template silently dropped. The primary path from the template library into the builder does nothing. |
| A2 | HIGH | `deal-panels.tsx:283-296`, `deal-page-handlers.ts:236` | **AI Context Settings do nothing.** Response Style (Detailed/Concise/Executive) + Include-citations save to `localStorage` but are never read; chat POST sends only `{message}`. User configures AI behavior with zero effect. |
| A3 | HIGH | `settings/PreferencesSection.tsx` (whole file), `settings/page.tsx:191` | **Preferences panel never rendered.** Investment Focus sectors, Preferred Currency, density, theme are fully built but no `<PreferencesSection/>` in the page — the settings are unreachable and stuck at defaults. |
| A4 | MED | `onboarding/team-task.tsx:13-89`, `page.tsx:304` | **Onboarding "Invite your team" discards emails.** Renders email+role rows and "Mark as done", but never POSTs to `/invitations`. Every teammate email typed is thrown away; user believes invites were sent. |
| A5 | MED | `settings/page.tsx:181-189,346-360` | **"Deactivate Account" is theater.** Full danger confirm dialog → on confirm just toasts "not available in this version". No deactivation happens. |
| A6 | MED | `memo-builder/chat.tsx:169-202` | **Chat file-upload paperclip discards files.** Opens the picker; `onChange` only resets the input — files never read/attached. |
| A7 | MED | `deal-tabs-ai-message-actions.tsx:18-27` | **AI "Helpful" thumbs-up goes nowhere.** Flips local state only — no API/telemetry. |
| A8 | MED | `dashboard/widgets/quick-actions.tsx:37` | **"Create Task" quick action** is a `<Link href="/admin">` — navigates to Admin, opens no task-create UI. |
| A9 | MED | `memo-builder/editor.tsx:398-407` (`:400`) | **"Add content" placeholder button has no `onClick`** — the inviting affordance does nothing. (Currently unreachable branch, but dead if rendered.) |
| A10 | LOW | `vdr/FileTable.tsx:98-104, 330-336` | Dead **select-all checkbox** (no state, no per-row checkboxes) and dead **"View all files"** button (no handler). |
| A11 | LOW | `settings/TeamSection.tsx:126-165` | **No revoke / cancel / resend** for pending/expired invitations — only "Copy Link". Once sent, an invite can't be managed. |
| A12 | LOW | dashboard | Dead unused file `components/layout/NotificationsDropdown.tsx` (Header uses `NotificationPanel` instead). Also the live `NotificationCenter` doesn't poll — unread badge can go stale while idle. |

---

## B. Customization gaps (hardcoded — should be org-configurable)

This is the bulk of the answer to "what should be customizable." For a multi-tenant PE CRM these are the ones firms will expect to configure.

| # | Sev | Where | Should be configurable |
|---|-----|-------|------------------------|
| B1 | HIGH | `lib/constants.ts:22-64` | **Deal pipeline STAGES** (`INITIAL_REVIEW`→`CLOSED_LOST`, Kanban columns, labels, styles). Every firm runs a different pipeline; drives Kanban, stage-change modal, filters. |
| B2 | HIGH | `contacts/components.tsx:46` | **Contact TYPES** (`BANKER/ADVISOR/EXECUTIVE/LP/LEGAL/OTHER`). Firms want custom counterparty types (Lender, Broker, Portfolio-co exec…). |
| B3 | MED | `memo-builder/components.tsx:82-95` | **IC memo SECTION TYPES** (Exec Summary, Deal Structure, Value Creation, Exit…). Firms have their own memo structure. |
| B4 | MED | analysis panels: `deal-analysis-diligence.tsx:74`, `-valuation.tsx:127,144`, `-cashcap.tsx:198`, `-overview.tsx:146` | **Fund thresholds** — leverage/IRR/DSCR/FCF-conversion bands drive user-facing **risk labels & severities**, not just colors. Different funds have different hurdle rates. Also the LBO caption "60% debt / 40% equity, 20% paydown / 5yr" is hardcoded. |
| B5 | MED | `graphs/constants.ts:7`, `Builder.tsx:352` | **Currency/unit** hardcoded `"$ M"` on every chart axis — misreports non-USD deals (e.g. INR-crore). Should derive from the deal's financial rows. |
| B6 | MED | `deal-panels.tsx:278` | **AI model** shown as static `"GPT-4o (ReAct Agent)"` — hardcoded, will silently misreport if the server model changes. Fetch from API. |
| B7 | MED | `lib/constants.ts:83-91` | **Deal-size bands** ($<10M / $10-50M…) and priority options — size bands are fund-size-dependent. |
| B8 | MED | data-room `upload-helpers.ts:6-12` vs `data-room-filters.tsx:33-45` | **Allowed upload types** (PDF/Excel/Word) don't match the filter buckets (which advertise CSV/PNG/JPG) — the "Image" filter is effectively dead; users can filter for files they can't upload. Reconcile + make configurable. |
| B9 | MED | data-room `page.tsx:151`, `data-loaders.ts:62` | **DD folder templates** — "default folders for due diligence" are server-generated with no UI to choose/customize the structure. |
| B10 | LOW | memo `export.ts:91,126,131`, `editor.tsx:233` | **Export branding** — PDF header color `#003366`, `Inter` font, "CONFIDENTIAL — FOR INTERNAL USE ONLY" footer all hardcoded; only PDF/MD/clipboard (no DOCX/PPTX). |
| B11 | LOW | dashboard `Header.tsx:13`, `Sidebar.tsx:201`, `team-performance.tsx:58`, `dashboard-widgets.tsx:228` | Support/feedback URLs + contact emails, team "capacity" denominator (`/5`), inbox/deadline/calendar lookback windows — all hardcoded ("web-next has no runtime config layer yet"). |
| B12 | LOW | contacts `detail-modals.tsx:214`, `detail-panel-sections.tsx:106`; onboarding `types.ts` | Relationship types, interaction types, AUM options, team roles — hardcoded defaults. Onboarding `TEAM_ROLES` (Analyst/VP/Partner) don't even map to the real API role enum (ADMIN/MEMBER/VIEWER). |

---

## C. Placeholder / stale content shown as real

| # | Sev | Where | Problem |
|---|-----|-------|---------|
| C1 | MED | `dashboard/widgets/market-multiples.tsx:7-18` | Hardcoded valuation-multiples table stamped **"As of Q1 2026"** — already stale, shown as reference data. |
| C2 | MED | `memo-builder/outline-sidebar.tsx:105-113` | **"Compliance Check: All citations are verified against the data room"** — hardcoded trust claim, no verification actually runs. |
| C3 | MED | `deal-analysis-aiinsights.tsx:79` | `hasMemo = false` hardcoded → the "Investment Memo Ready" branch is dead; panel always shows the Generate state. |
| C4 | MED | `deal-analysis-aiinsights.tsx:33-37` | AI Insights empty state says "Refresh in a few seconds…" but there's **no auto-poll and no refresh button** — user must guess and reload. |
| C5 | LOW | `memo-builder/editor.tsx:158,234` | Fake pagination "Page 1 of N" (rough estimate). |
| C6 | LOW | `settings/SecuritySection.trust.tsx:114` | Trust page hardcodes "34 automated tests / 268 org-scope checks (audited 2026-04-30)" — will silently go stale. |
| C7 | LOW | `graphs/Gallery.tsx:81` | Saved-graph cards show label chips in a dashed box, never an actual chart preview (documented as intentional). |

---

## D. Coming-soon stubs (intentional — decide: ship, or stop teasing)

- **Market Sentiment** dashboard widget — `comingSoon:true`; its card (`MarketSentimentCard`, `dashboard/components.tsx:230`) is actually **fully built but orphaned**. Wire it in or remove the teaser.
- **Fireflies / Otter** integration tiles — disabled "Coming soon" (`IntegrationsSection.tsx:23`).
- **In-app document preview** — none; clicking a file downloads it (row styling implies "open to view"). Legacy PDF.js/SheetJS viewer not ported (MVP decision).
- **Dark mode / layout density** — controls exist but gated behind `{false && …}` (`PreferencesSection.tsx:119`).
- **Firm-teaser generate-prompt** — graceful "not available yet (endpoint not deployed)" fallback; verify the endpoint is live in prod.

---

## Verified clean (large, not padding)
Deals list/detail (import, filter, sort, bulk stage/delete/pass, CSV export, Kanban DnD), contacts CRUD + connections + interactions, data-room folder/file CRUD + upload + re-analyze + insights, memo/template CRUD + reorder + share + export, command palette, notifications mark-read, AI assistant streaming + tool actions, all integration Connect/Disconnect/Sync + HubSpot import, MFA enroll, session revoke. No `href="#"`, empty handlers, or `console.log`-only controls in the wired areas.
