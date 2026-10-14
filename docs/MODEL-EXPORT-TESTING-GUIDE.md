# Model Export (.xlsx) — QA Testing Guide

**Feature:** the "Download .xlsx" button on a deal's Build model panel
**What changed:** PR #173 (merged) — the downloaded Excel file used to open mostly **blank**. Every number is a formula, and the file never saved a calculated result next to each formula — so anything that doesn't recalculate on open (which is most ways people actually open a downloaded file) showed empty cells instead of numbers.
**Goal of this test:** confirm the download now shows real numbers everywhere, in the ways people actually open files — not just in desktop Excel with editing turned on.

---

## Before you start

- Log in at **deals.avise.io** with the QA account (`qa.tester@example.com`) — Ganesh will share the password.
- Use the deal **"Northwind Cold Chain"** in the **Avise QA Test Org**. It already has financials extracted, so its model is ready to download. (If it's missing, ask Ganesh — don't use a real customer's deal for this.)
- You'll need:
  - **Windows with desktop Excel**, if available — this is the most important check (see Step 2).
  - A **Mac**, if available — for the Quick Look check (Step 3).
  - Any phone or the Slack/Gmail web app, for the preview check (Step 4) — optional but useful.
- If you only have one of these, that's fine — do what you can and note in your report which checks you skipped.

**What "pass" looks like:** every sheet is full of numbers, percentages and dollar amounts — nothing is blank.
**What "fail" looks like:** a sheet (or part of one) shows empty cells where you'd expect a number, in *any* of the ways below. A file that only shows numbers after you click something in Excel ("Enable Editing", "Enable Content") still **fails** this test — the whole point of the fix is that you shouldn't have to do that.

---

## Step 1: Download the file

1. Open the **Northwind Cold Chain** deal.
2. Scroll down on the left side past "Financial Statements" to the **"Build model"** card.
3. It has three tabs near the top-right: **Low / Base / High**. Start on **Base**.
4. Click **"Download .xlsx"** (dark blue button, top-right of the card). It briefly says "Building…" then downloads.
5. Repeat for **Low** and **High** as well — download all three and keep them (name them `base.xlsx`, `low.xlsx`, `high.xlsx` so you don't mix them up).

---

## Step 2: Open in desktop Excel — the main check

This is the check that matters most, because it's how most people will actually open this file.

1. Find `base.xlsx` in your Downloads folder and **double-click it to open it directly** (don't open Excel first and then open the file from inside it — double-clicking from Downloads is what triggers the real-world behavior we're testing).
2. **On Windows**, Excel will likely show a yellow bar at the top: *"Protected View — Be careful, files from the internet can contain viruses…"* with an **"Enable Editing"** button.
   - **Do not click "Enable Editing" yet.** While that yellow bar is showing, look through the sheet tabs at the bottom (Cover, Assumptions, Scenarios, Historicals, Projections, Returns, Sensitivity, Notes). **Every sheet with numbers in it should already show them** — revenue, EBITDA, IRR, percentages, everything. Nothing should be blank.
   - This is the actual bug we're checking for. Before the fix, these sheets were empty until you clicked "Enable Editing".
   - Once you've checked, you can click "Enable Editing" and confirm the numbers stay the same (they should — editing just turns formulas back on, it shouldn't change any numbers).
3. **On Mac,** desktop Excel doesn't always show the same yellow bar, so just open the file normally and go through Step 2's sheet checklist below.

### Sheet-by-sheet checklist (do this for `base.xlsx`)

Go through every tab at the bottom and confirm nothing is blank:

| Sheet | What to look for |
|---|---|
| **Cover** | Deal name, currency, "millions", the list of source documents |
| **Assumptions** | Every row (entry multiple, debt, tax rate, exit multiple, etc.) has a number in the Low / Base / High / **Live** columns — the Live column especially, since that's what the rest of the model reads from |
| **Scenarios** | Three blocks (Low, Base, High) each full of numbers — revenue, EBITDA, IRR, MoM for every case, side by side |
| **Historicals** | Every historical period column has revenue, costs, EBITDA etc. filled in |
| **Projections** | Every projected year column has revenue, EBITDA, margins, cash flow lines filled in |
| **Returns** | Sources & uses, the debt schedule, and at the bottom: **IRR** and **MoM** — should be a real percentage/multiple, or the text **"n/a"** (both are fine — "n/a" just means this deal's cash flows genuinely don't produce a return, not that something's broken) |
| **Sensitivity** | A grid of numbers (entry multiple vs. exit multiple) |
| **Notes** | Paragraphs of text explaining the model's assumptions |

**Specifically check these, since they're what broke before the fix:**
- On **Returns**, the **IRR** and **MoM** cells near the bottom — not blank.
- On **Returns**, "Opening net debt" — if this deal has no balance sheet, this should show **0** (not blank). A missing value is different from a real zero, and this is a case where it's genuinely zero.
- On **Assumptions**, the **Live** column (the 4th column in each block) — this is the one the whole model actually uses, so if anything in the workbook looks wrong, check whether the Live column itself is blank or wrong first.

Repeat the same checklist for `low.xlsx` and `high.xlsx` — just a quick pass, you don't need to re-check every cell, but confirm the Scenarios and Returns sheets have numbers.

---

## Step 3: Mac Quick Look (if you have a Mac)

1. In Finder, click once on `base.xlsx` to select it (don't open it).
2. Press the **spacebar** — this opens Quick Look, a fast preview that never runs Excel at all.
3. You should see the spreadsheet with numbers filled in, same as Step 2's checklist (Quick Look only shows the active sheet, so just confirm whichever sheet it opens to — likely Cover or Assumptions — isn't blank).
4. This is a good check because Quick Look has no "Enable Editing" option at all — if the file doesn't carry saved numbers, this view will always be blank, with no way to fix it from the viewer side.

---

## Step 4: A chat/email preview (optional, nice to have)

If you have a few minutes:
1. Send `base.xlsx` to yourself on Slack, or attach it to an email, or upload it to Google Drive.
2. Open the inline preview (Slack's file preview pane, Gmail's eye icon, or Google Drive's preview) **without downloading or opening it in a full app**.
3. Confirm it shows numbers, not a blank grid.

This step is the same underlying check as Quick Look — these previews never calculate formulas either — so if Steps 2 and 3 both passed, this will very likely pass too. Skip it if you're short on time.

---

## What to report back

For each file you tested (base / low / high) and each way you opened it (Excel Protected View, Quick Look, chat preview), say **pass** or **fail**.

If something fails:
- Tell us **which file**, **which sheet**, and roughly **which cells** were blank (a screenshot is the easiest way).
- Tell us **how you opened it** (Protected View before clicking Enable Editing? Quick Look? desktop Excel after opening normally?).
- No need to dig further than that — that's enough for us to track it down.

If everything passes: just confirm "all checks passed" and which of Steps 2/3/4 you were able to run.
