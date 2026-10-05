# Command Center v2 — "Team ledger"

Approved by the founder on 2026-09-28. It uses the same visual language as the dashboard "Morning brief" (`.impeccable.md`; shared styles in `src/components/dash/`).

## Goal
Answer **who's stretched, what's slipping, and how do I rebalance?** Every fix is available in context, pre-filled, in a side sheet.

## Layout
A masthead, then a main column (Slipping → Team workload → Tasks) and a rail (Security → Upcoming reviews → Team activity). The rail drops under the main column below 1280px.

- **Masthead:**
  - A date line, "Command Center" and a summary: *N people · N live deals · N tasks overdue · N deals without an owner*. The counts jump to the relevant section; "overdue" also switches the task table to its Overdue tab.
  - A **New ▾** menu: Assign deal and Create task (ADMIN only), Schedule review and Send reminder.
  - "Updated X ago ↻".
  - **Removed:** the four stat cards. "Deal volume" summed mixed currencies and test data into "$10000001B". The fake "System Operational" pill is also gone.
- **Slipping:** org-wide overdue tasks (oldest first), then unowned live deals, then stale deals (no update in 14+ days). It reuses the dashboard's `triage.ts` rules.
  - **Overdue task:** Nudge (a pre-filled reminder) and Reassign ▾ (ADMIN).
  - **Unowned deal:** Assign (opens the assign sheet with the deal chosen).
  - **Stale deal:** Nudge owner, plus Open.
- **Team workload:** one row per active member, showing live deals (owner or team member), open tasks and overdue tasks.
  - **Load** is `deals×2 + open tasks`, scaled to the busiest person on the team.
  - **Tags:** *Idle* when there's nothing assigned. *Stretched* when a person has 2+ overdue tasks, or is at 80%+ load with a score of 6 or more.
  - Deal names are de-duplicated ("DMpro ×2").
  - The ⋯ menu opens Assign, Task or Reminder pre-filled for that person.
- **Tasks:**
  - **Tabs:** Open · Overdue · Due this week · Done · All, each with a count.
  - **Due column:** "3 days overdue", "Due Thu" or "Done Sep 12". This fixes "In -215 days".
  - **Deal:** shown under the task name rather than in its own column.
  - **Editing:** the status menu has an undo. Delete asks for inline confirmation (Delete / Keep).
- **Rail:**
  - **Security:** the headline plus four figures (staff access, failed logins, admin actions, 2FA), with recent actions and most-viewed deals folding open in place. Same endpoint as before.
  - **Upcoming reviews:** now a light panel (the dark navy card is gone).
  - **Team activity:** restyled, with the same filters, CSV export and paging.

## Actions
- **Side sheet:** the four existing forms render in the shared right-side sheet (`Modal.tsx` wraps `SideSheet`) and accept a `prefill` (deal, user, message, title).
- **APIs unchanged:** `POST /deals/:id/team`, `POST /tasks`, `[Review]`-prefixed tasks, `POST /notifications` and `PATCH /tasks/:id` (status, `assignedTo`).
- **Feedback:** outcomes use the shared undo bar.

## Access
Unchanged. ADMIN, PARTNER and PRINCIPAL can view the page; only ADMIN can assign deals and create tasks.

## Tests
- `admin-logic.test.ts`: due labels, workload scaling and tags, slipping order, nudge contact and name de-duplication.
- `action-sheet.test.tsx`: the sheet opens pre-filled and posts the reminder, and Esc closes it.
- A visual check with mock data at 1600px and 390px.

## Out of scope
Backend changes and migrations.
