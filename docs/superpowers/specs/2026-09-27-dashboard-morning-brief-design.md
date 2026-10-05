# Dashboard v2 — "Morning brief"

Approved by the founder on 2026-09-27. Design context: `.impeccable.md` (refined banker, Inter product-wide, light).

## Goal
The first 5 seconds on the dashboard answer **"what needs me today?"** People can act on the small things inline, and anything bigger opens the deal.

## Layout
A briefing column plus a context rail. The rail drops under the main column below 1280px.

- **Masthead:** date line, greeting and a summary that leads with the queue count ("3 things need you today. 17 live deals, 3 in diligence.").
  - Actions are **New deal** (primary) and a **Customize ▾** menu (Add widget / Edit layout).
  - It shows "Updated X ago ↻". Data refetches silently when the tab regains focus after 5+ minutes away.
- **Main column:**
  1. **Today queue** (always shown).
  2. **Pipeline funnel**, respecting the `stats-cards` visibility setting.
  3. **Active Priorities**, respecting the `active-priorities` visibility setting.
- **Rail:** My Tasks, Sector mix, Inbox Deal Finder (core IDs `my-tasks`, `portfolio-allocation`, `ai-deal-signals`), followed by the enabled optional widgets. The rail is reorderable in edit mode.

## Today queue rules (`triage.ts`, pure and unit-tested)
"My" tasks means open tasks where `assignedTo` is the current user or is empty. A deal is live unless its status is ARCHIVED/PASSED or its stage is PASSED/CLOSED_WON/CLOSED_LOST.

| Kind | Rule | Actions |
|---|---|---|
| overdue | my open task, due before today | Complete (undo), Snooze 1 day |
| due-today | my open task, due today | Complete (undo), Snooze 1 day |
| stale | live deal, `updatedAt` ≥ 14 days ago | Open, Snooze 7 days |
| unowned | live deal with no `assignedUser` that is HIGH/URGENT priority or at DUE_DILIGENCE or later | Assign ▾ (from `GET /users`), Snooze 7 days |

- **Ordering:** overdue (oldest first), then due-today, then unowned, then stale (stalest first).
- **Display:** the first 6 items show; the rest sit behind "Show N more".
- **Snoozes:** stored in localStorage under key `avise-dash-snoozes`, as `{[itemKey]: untilEpochMs}`. Expired entries are pruned on read.
- **Empty state:** "You're clear for today", plus the next upcoming due task if there is one.

## Pipeline funnel
- **Stages:** Sourcing (INITIAL_REVIEW), Diligence (DUE_DILIGENCE), IOI / LOI (IOI_SUBMITTED, LOI_SUBMITTED, LOI_OFFER), Negotiation (NEGOTIATION, CLOSING), Closed (CLOSED_WON).
- **Each stage shows:** count, share of live deals as a bar, and a stale count when it's above zero.
- **Click:** opens the **Deals drawer**, a right-side sheet with Esc/overlay close and focus on open. It replaces the centred stage modal.

## Active Priorities
- **Tabs:**
  - *By priority*: URGENT > HIGH > MEDIUM > LOW, then most recently updated.
  - *Needs attention*: stale or unowned deals.
  - *Recently updated*.
- **Columns:** Deal (+ High/Urgent tag, industry), Stage (step marker), Owner, Last touch (amber once stale), Next action, Value.
- **Rows:** 6 per tab, with a footer "All N deals →". Row hover or focus reveals *Open* and *Data room*.

## Rail
- **My Tasks:**
  - Grouped into Overdue, Today, Upcoming and No date. Completed tasks collapse behind "N done ▸".
  - Completing a task is optimistic and shows the undo bar.
  - **+ Add task** takes a title and a due chip (None / Today / Tomorrow / Next week), then POSTs `/tasks` assigned to me.
- **Sector mix:**
  - Labels are normalised (trimmed, case-folded, "&"/"and" unified, a trailing "s" dropped), and the most common original spelling is displayed.
  - The top 4 sectors plus "Others" are shown; clicking a sector opens the Deals drawer filtered to it.
- **Inbox Deal Finder:** unchanged logic.

## Cross-cutting
- **Undo bar:** local to the dashboard (the global toast has no actions). "Task completed · Undo", auto-dismisses after 6s.
- **Failures:** an action that fails rolls back and shows an error toast. Each section also has its own error state with a Retry.
- **Loading:** skeletons match the new layout, including the route-level `loading.tsx`.
- **Accessibility:** every item is keyboard-reachable, the queue has an `aria-live` region, and all icon buttons are labelled.
- **Phones:** row actions collapse into a ⋯ menu.
- **Motion:** a single reveal, and `prefers-reduced-motion` is honoured.

## Out of scope
Backend changes, migrations, other pages, and moving snoozes to the server (a later step).

## Testing
- **Unit tests** for `triage.ts`: queue rules and order, sector normalisation, snooze expiry and due labels.
- **Component test:** complete → undo on the Today queue.
- **Visual check:** the mock-data preview at 1440px and 390px.
