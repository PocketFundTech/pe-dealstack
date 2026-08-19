# Avise — AI Features QA Testing Guide

**Purpose:** Thoroughly test every AI feature in Avise before recording the Loom demo video. Test happy paths, edge cases, and error handling. Document any bugs found.

**URL:** https://lmmos.ai/login
**Prerequisites:** Active account with at least 1 deal (with uploaded documents + extracted financials), a few contacts, and documents in the Data Room.

---

## Quick Reference

| # | Feature | Page | How to Find It | Status |
|---|---------|------|-----------------|--------|
| 1 | Portfolio Signal Monitor | Dashboard | "Scan Signals" button on AI Deal Signals widget | Working |
| 2 | Portfolio Chat | Dashboard (header) | Search bar: "Ask AI anything about your portfolio..." | Working |
| 3 | Deal Chat AI | Deal page | Right panel — chat box at bottom | Working |
| 4 | Meeting Prep | Deal page | Click ⋮ (three dots menu) → "Meeting Prep" | Working |
| 5 | Email Drafter | Deal page | Click ⋮ (three dots menu) → "Draft Email" | Working |
| 6 | Financial Extraction | Deal page | Upload a PDF or Excel file to the deal | Working |
| 7 | AI Financial Analysis | Deal page | Appears automatically after financials are extracted (5 tabs) | Working |
| 8 | AI Contact Enrichment | Contacts page | Click on a contact → "AI Enrich" button | Working |
| 9 | AI Quick Insights | Data Room (VDR) | Select a folder → right panel shows insights | Working |
| 10 | Generate Full Report | Data Room (VDR) | Button at bottom of insights panel | Working |
| 11 | AI Section Generation | Memo Builder | Regenerate (🔄) icon on a section | Partially Working |
| 12 | AI Analyst Chat | Memo Builder | Right panel chat | Partially Working |
| 13 | Compliance Check | Memo Builder | Green badge at bottom-left | UI Only |
| 14 | Export to PDF | Memo Builder | "Export to PDF" button (top-right) | Working |

---

## How to Report Bugs

For each failed test, note:
- **Feature name** and **test number** (e.g., "Deal Chat - Test 3")
- **What you did** (steps you followed)
- **What you expected** to happen
- **What actually happened** (error message, blank screen, nothing happened, etc.)
- **Screenshot** if possible

---

## 1. Dashboard

### 1.1 Portfolio Signal Monitor

**What it does:** Scans all your deals for risks, opportunities, and signals using AI. Shows color-coded signal cards (red = critical, amber = warning, blue = info).

**Where:** Dashboard page → right side → "AI Deal Signals" widget card

#### Test 1: Basic Scan
1. Go to Dashboard
2. Find the "AI Deal Signals" widget (it has a radar icon)
3. You should see empty state text: "Portfolio Signal Monitor" and "Click 'Scan Signals' to analyze..."
4. Click the **"Scan Signals"** button (blue button, top-right of widget)
5. Wait — button should show a spinning icon and say "Scanning..."
6. Results should appear as colored signal cards

**Expected:** Signal cards appear with title, description, deal name, and a suggested action. Each card is color-coded (red/amber/blue). A green toast notification appears at top-right.

- [ ] Button changes to "Scanning..." with spinner while loading
- [ ] Signal cards appear after loading
- [ ] Each card shows: signal title, deal name, description, severity badge, suggested action
- [ ] Toast notification appears (either "Signals Found — X signal(s) detected" or "No Signals — Portfolio looks clean")
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: No Deals Scenario
1. If possible, test with an account that has no deals
2. Click "Scan Signals"

**Expected:** Should either show "All Clear — No actionable signals" with a green checkmark, or handle gracefully with an info message. Should NOT crash or show a blank screen.

- [ ] Handles empty portfolio gracefully
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Scan Again
1. After the first scan shows results, click "Scan Signals" again
2. The results should refresh (may show same or different signals)

**Expected:** Previous results clear, new scan runs, fresh results appear.

- [ ] Re-scan works without errors
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Signal Card Details
1. After a successful scan, examine the signal cards closely
2. Check that each card has the correct icon for its type (e.g., trending_down for risk, rocket_launch for opportunity)
3. Check severity badges: "CRITICAL" in red, "WARNING" in amber, "INFO" in blue

**Expected:** Cards are readable, properly formatted, and color-coded.

- [ ] Icons match signal type
- [ ] Severity badges are color-coded correctly
- [ ] Suggested actions are readable and make sense
- [ ] Pass / Fail

**Notes:** ___

---

### 1.2 Portfolio Chat (AI Search Bar)

**What it does:** Ask AI questions about your entire portfolio — deal counts, revenue, EBITDA, comparisons, industry breakdowns.

**Where:** Top header bar → search input that says **"Ask AI anything about your portfolio..."** with a sparkle (✦) icon

#### Test 1: Basic Query
1. Click on the search bar at the top of the dashboard
2. A dropdown should appear showing "Recent Searches" and "Quick Actions"
3. Type: **"What's the average EBITDA margin in our portfolio?"**
4. Press Enter or click the search button
5. Wait for AI response

**Expected:** AI responds with portfolio-level analysis in a results area. Response should reference actual deals in your portfolio.

- [ ] Search bar accepts input
- [ ] Dropdown with recent searches appears on focus
- [ ] AI response appears after submitting query
- [ ] Response references real deal data from your portfolio
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Deal-Specific Query
1. Type: **"Show me all healthcare deals"** (or whatever industry your deals are in)
2. Press Enter

**Expected:** AI lists deals matching that industry with relevant details.

- [ ] Response filters/shows correct deals
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Comparison Query
1. Type: **"Compare [Deal A] vs [Deal B]"** (use two real deal names from your portfolio)
2. Press Enter

**Expected:** AI provides a side-by-side comparison of the two deals.

- [ ] Comparison includes key metrics (revenue, stage, etc.)
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Empty/Vague Query
1. Type just a single letter like "a" and press Enter
2. Then try an empty search (just press Enter with nothing typed)

**Expected:** Should either prompt for more detail or handle gracefully. Should NOT crash.

- [ ] Short/empty queries handled gracefully
- [ ] Pass / Fail

**Notes:** ___

#### Test 5: Quick Actions
1. Click the search bar to open the dropdown
2. Click **"Create New Deal"** under Quick Actions
3. Go back to dashboard, click search bar again
4. Click **"View AI Reports"**

**Expected:** Each quick action navigates to the correct page.

- [ ] "Create New Deal" navigates to deal creation
- [ ] "View AI Reports" navigates to reports/memos
- [ ] Pass / Fail

**Notes:** ___

---

## 2. Deal Page

**Navigation:** Click on any deal from the Dashboard's "Active Priorities" table, or from the Pipeline/CRM page.

### 2.1 Deal Chat AI (Deal Assistant)

**What it does:** Chat with AI about a specific deal. Ask questions about financials, documents, risks, and comparisons. The AI can search your uploaded documents, pull financial data, compare deals, and suggest actions.

**Where:** Deal page → right panel labeled **"Deal Assistant AI"** with a green dot and "BETA" badge. Chat input at the bottom says **"Ask about the deal, financials, or risks..."**

#### Test 1: Basic Question
1. Open any deal page
2. In the chat box at the bottom-right, type: **"Give me a summary of this deal"**
3. Press Enter (or click the send arrow button)
4. Wait for the AI to respond

**Expected:**
- Your message appears on the right side (light gray background)
- A typing indicator (three bouncing dots) appears while AI thinks
- AI response appears on the left with "Avise AI • GPT-4" label and a blue gradient avatar
- Response contains a relevant summary of the deal

- [ ] Message sends successfully
- [ ] Typing indicator shows while AI processes
- [ ] AI response appears with proper formatting
- [ ] Response is relevant to the actual deal
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Financial Question
1. Type: **"What are the revenue and EBITDA numbers for this deal?"**
2. Press Enter

**Expected:** AI pulls financial data from extracted statements and presents numbers.

- [ ] AI references actual financial data (not made-up numbers)
- [ ] Numbers are formatted properly (currency format)
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Document Search
1. Type: **"What does the CIM say about the management team?"** (or any topic from an uploaded document)
2. Press Enter

**Expected:** AI searches through uploaded documents and references specific findings.

- [ ] AI references specific document content
- [ ] Response is relevant to the query
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Deal Comparison
1. Type: **"Compare this deal with [another deal name]"** (use a real deal from your portfolio)
2. Press Enter

**Expected:** AI compares the two deals on key metrics.

- [ ] Comparison includes both deals
- [ ] Key metrics are compared (revenue, stage, industry, etc.)
- [ ] Pass / Fail

**Notes:** ___

#### Test 5: File Attachment
1. Click the **📎 (paperclip)** button to the left of the send button
2. Select a PDF or Excel file from your computer (under 25MB)
3. Wait for the file to upload — you should see a chip with the filename and a spinner
4. After upload completes, the chip should show a ✅ checkmark
5. Type a message like: **"Analyze the attached document"**
6. Press Enter

**Expected:** File uploads to the deal's Data Room. AI acknowledges the file and can reference it.

- [ ] File picker opens when clicking 📎
- [ ] Upload progress shown (spinner → checkmark)
- [ ] Attached file chip appears with remove (X) button
- [ ] AI acknowledges and can reference the uploaded file
- [ ] Pass / Fail

**Notes:** ___

#### Test 6: Clear Chat History
1. Click the **🗑️ (trash)** icon at the top-right of the chat panel
2. A confirmation modal should appear: "Clear Conversation?" with "All messages for this deal will be permanently removed."
3. Click **"Cancel"** — nothing should happen
4. Click 🗑️ again → click **"Clear"** (red button)
5. Chat should reset to the intro message: "I'm ready to help analyze this deal..."

**Expected:** Confirmation modal prevents accidental deletion. After confirming, chat resets cleanly.

- [ ] Confirmation modal appears before clearing
- [ ] Cancel keeps chat history intact
- [ ] Clear removes all messages
- [ ] Intro message is restored after clearing
- [ ] Toast: "Chat Cleared — Conversation history has been cleared"
- [ ] Pass / Fail

**Notes:** ___

---

### 2.2 Meeting Prep

**What it does:** AI generates a meeting briefing document with talking points, questions to ask, risks, and a suggested agenda — based on deal data, contacts, and documents.

**Where:** Deal page → click the **⋮ (three dots)** button in the top-right → look for **"Meeting Prep"** under the AI Tools section

#### Test 1: Generate Brief with Topic
1. Click ⋮ menu → **"Meeting Prep"**
2. A modal opens with header "AI Meeting Prep" and the deal name
3. In **"Meeting Topic"** field, type: **"Management presentation review"**
4. Leave **"Meeting Date"** as today (auto-filled)
5. Click **"Generate Meeting Brief"** (blue button)
6. Wait for loading (spinning icon + "Generating meeting brief..." + "Analyzing deal data, contacts, and documents")

**Expected:** Results appear with up to 7 sections: Deal Summary, Contact Profile, Key Talking Points, Questions to Ask, Risks to Address, Document Highlights, Suggested Agenda. Each section has an icon.

- [ ] Modal opens correctly with deal name
- [ ] Loading spinner shows during generation
- [ ] Brief appears with multiple sections
- [ ] Talking points are relevant to the deal
- [ ] Questions to ask are data-driven
- [ ] Risks are specific (not generic)
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Export to Doc
1. After generating a brief (from Test 1), scroll to the bottom
2. Click **"Export to Doc"** (blue button with download icon)
3. A `.txt` file should download named `meeting-prep-YYYY-MM-DD.txt`

**Expected:** File downloads with all sections from the brief formatted as text.

- [ ] File downloads automatically
- [ ] File contains all sections from the brief
- [ ] Text is readable and well-formatted
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Empty Topic
1. Open Meeting Prep modal again
2. Leave the **"Meeting Topic"** field completely empty
3. Click **"Generate Meeting Brief"**

**Expected:** Either prompts for a topic, or generates a generic brief. Should not crash.

- [ ] Handles empty topic gracefully
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Close and Reopen
1. Generate a brief
2. Click **"Close"** button
3. Reopen Meeting Prep from ⋮ menu

**Expected:** Modal reopens fresh with the input form (not previous results).

- [ ] Modal reopens with clean form
- [ ] Pass / Fail

**Notes:** ___

---

### 2.3 Email Drafter

**What it does:** AI drafts professional emails with template selection, tone adjustment, and compliance checking. Goes through 4 AI steps: draft → tone check → compliance check → finalize.

**Where:** Deal page → click **⋮ (three dots)** → **"Draft Email"**

#### Test 1: Basic Email Draft
1. Click ⋮ → **"Draft Email"**
2. Modal opens with fields:
   - **Template:** Select "Follow-up" (or any template from the dropdown)
   - **Tone:** Select "Professional" (default)
   - **Purpose:** Type **"Follow up after management meeting to discuss next steps"** (required field — red asterisk)
   - **Additional Context:** Leave empty
3. Click **"Generate Draft"** (blue button)
4. Wait for loading ("Drafting email..." + "Draft → Tone check → Compliance check → Review")

**Expected:** Results show:
- Status header (green "Ready for Review" or amber "Compliance Issues")
- "Tone Score: X/100" on the right
- Subject line in a gray box
- Email body in a white box
- Optional: Tone feedback, compliance issues, suggestions

- [ ] Template dropdown shows 7+ templates
- [ ] Tone dropdown shows 5 options (Professional, Friendly, Formal, Direct, Warm)
- [ ] Purpose field is required (can't submit empty)
- [ ] Loading shows the 4-step pipeline text
- [ ] Draft appears with subject + body
- [ ] Tone score is displayed
- [ ] Status badge shows (green or amber)
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Copy to Clipboard
1. After generating a draft (from Test 1)
2. Click **"Copy to Clipboard"** button (copy icon)
3. Open any text editor and paste

**Expected:** Both subject line and email body are copied. Toast notification: "Copied — Email draft copied to clipboard"

- [ ] Copy button works
- [ ] Pasted text includes subject + body
- [ ] Toast notification appears
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Different Tones
1. Generate an email with **"Formal"** tone
2. Close and regenerate with **"Friendly"** tone using the same purpose

**Expected:** The two drafts should have noticeably different writing styles.

- [ ] Formal tone is more buttoned-up
- [ ] Friendly tone is warmer/casual
- [ ] Tone score may differ between the two
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Compliance Check
1. Try purpose: **"Send confidential financial projections to external party"**
2. Generate draft

**Expected:** Compliance check should flag potential issues (sharing confidential info externally). Status may show amber "Compliance Issues" with warnings.

- [ ] Compliance issues are flagged when appropriate
- [ ] Issues shown in red section with gavel icon
- [ ] Pass / Fail

**Notes:** ___

#### Test 5: Short/Invalid Purpose
1. Try purpose with less than 5 characters (e.g., "Hi")
2. Try to generate

**Expected:** Should show validation error — purpose needs at least 5 characters.

- [ ] Validation prevents submission with short purpose
- [ ] Pass / Fail

**Notes:** ___

---

### 2.4 Financial Extraction

**What it does:** When you upload a PDF (CIM, financial report) or Excel file to a deal, AI automatically extracts financial statements (Income Statement, Balance Sheet, Cash Flow) using a 5-step pipeline: Extract → Verify → Validate → Self-Correct → Store.

**Where:** Deal page → upload a document (via Data Room or deal page upload)

#### Test 1: PDF Extraction
1. Open a deal page
2. Upload a PDF that contains financial data (e.g., a CIM with income statement)
3. Navigate to the Financial Statements section on the deal page
4. Wait for extraction to process (may take 30-60 seconds)

**Expected:** Extracted financial data appears in a table with statement types (Income Statement, Balance Sheet, Cash Flow), periods, and values in millions USD. Confidence badges show per period.

- [ ] Financial statements appear after upload
- [ ] Data is organized by statement type (tabs or sections)
- [ ] Values are shown in millions USD
- [ ] Confidence percentage is displayed
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Excel Extraction
1. Upload an Excel file with financial data (P&L, balance sheet)
2. Check Financial Statements section

**Expected:** AI extracts data from relevant sheets (ignores junk sheets like "Cover", "Assumptions").

- [ ] Excel data extracted correctly
- [ ] Correct sheets selected (financial ones, not summary/cover)
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Non-Financial Document
1. Upload a document with NO financial data (e.g., a legal contract or a cover letter)
2. Check Financial Statements section

**Expected:** Either no financial data extracted (graceful handling) or very low confidence warning.

- [ ] Handles non-financial documents gracefully
- [ ] Does not show garbage data
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Multiple Documents
1. Upload two different financial documents to the same deal (e.g., two CIMs with overlapping periods)
2. Check Financial Statements section

**Expected:** If data conflicts exist, a merge conflict UI should appear letting you choose which values to keep. Look for "needs_review" status or a merge resolution modal.

- [ ] Multiple documents are processed
- [ ] Conflicts detected and shown (if overlapping)
- [ ] Pass / Fail

**Notes:** ___

---

### 2.5 AI Financial Analysis

**What it does:** Once financials are extracted, AI automatically generates a comprehensive analysis dashboard with 5 tabs containing 13+ analysis modules: QoE score, ratios, EBITDA bridge, revenue quality, red flags, LBO screen, benchmarking, and more.

**Where:** Deal page → scroll down to the **"AI FINANCIAL ANALYSIS"** section (dark blue header with "QoE: XX/100" badge). Has 5 tabs: **Overview | Deep Dive | Cash & Capital | Valuation | Diligence**

**Prerequisite:** The deal must have extracted financial statements (from Test 2.4 above).

#### Test 1: Overview Tab
1. Open a deal with extracted financials
2. Find the "AI FINANCIAL ANALYSIS" section
3. Click on the **"Overview"** tab (should be selected by default)

**Expected:**
- QoE (Quality of Earnings) score in a circle badge (0-100) with label (Poor/Moderate/Good/Strong)
- Color-coded: red (<40), amber (40-60), green (>60)
- Key metrics cards: Revenue CAGR, FCF Conversion, Net Leverage, LBO Screen (Pass/Fail)
- Key Findings section with critical/warning badges

- [ ] QoE score displays in circle with percentage
- [ ] Score label matches range (Poor/Moderate/Good/Strong)
- [ ] Key metric cards show values
- [ ] Key Findings listed with severity badges
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Deep Dive Tab
1. Click **"Deep Dive"** tab

**Expected:** Ratio Dashboard with interactive charts. Includes profitability ratios, efficiency ratios, leverage ratios. DuPont Analysis breakdown.

- [ ] Tab loads without errors
- [ ] Charts/tables display
- [ ] Ratios are calculated with proper values
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Cash & Capital Tab
1. Click **"Cash & Capital"** tab

**Expected:** Cash Flow Analysis, Working Capital trends, Cost Structure breakdown, EBITDA Bridge.

- [ ] Tab loads without errors
- [ ] Cash flow and working capital data displayed
- [ ] EBITDA bridge shows adjustments
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Valuation Tab
1. Click **"Valuation"** tab

**Expected:** LBO Screen with entry/exit scenarios, Cross-Document analysis, Portfolio Benchmarking (percentile ranking vs peers).

- [ ] Tab loads without errors
- [ ] LBO screen shows scenarios
- [ ] Benchmarking compares against portfolio peers
- [ ] Pass / Fail

**Notes:** ___

#### Test 5: Diligence Tab
1. Click **"Diligence"** tab

**Expected:** Red flags listing (25+ flag types), detailed quality of earnings assessment, conflict resolution for multi-document extractions.

- [ ] Tab loads without errors
- [ ] Red flags listed with severity levels
- [ ] Each red flag has description and source
- [ ] Pass / Fail

**Notes:** ___

---

## 3. Contacts

### 3.1 AI Contact Enrichment

**What it does:** AI enriches a contact's profile using LLM inference — adds job title, company, industry, location, contact type, insights, and suggested actions. Confidence score is capped based on how much info the contact already has (name only = max 30%, name+email = max 50%).

**Where:** Contacts page → click on any contact to open the detail panel → look for the **"AI Enrich"** button (blue, with sparkle icon) in the action buttons bar

#### Test 1: Enrich a Contact with Full Info
1. Go to the Contacts page
2. Click on a contact that has name + email + company already filled in
3. Click the **"AI Enrich"** button
4. Button should change to "Enriching..." with a spinning icon

**Expected:** Results panel appears below the contact details with:
- Status: "Auto-saved" (green) if high confidence, "Needs Review" (amber) if low
- Confidence percentage (e.g., "65% confidence")
- Enriched fields: Title, Company, Industry, Location, Relevance badge, Contact Type badge
- Key insight (blue box with lightbulb icon)
- Suggested action (green box with arrow icon)

- [ ] Button shows "Enriching..." with spinner during processing
- [ ] Results panel appears with colored border (green/amber/red)
- [ ] Confidence % is displayed
- [ ] At least some enriched fields appear (Title, Company, Industry)
- [ ] Key insight box shows relevant info
- [ ] Suggested action is actionable
- [ ] Toast notification: "Enrichment Complete — Contact enriched with X% confidence"
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Enrich a Contact with Minimal Info
1. Find or create a contact with ONLY a name (no email, no company)
2. Click "AI Enrich"

**Expected:** Confidence should be capped at ~30% (low). Status should show "Needs Review" (amber). Results may be sparse.

- [ ] Low confidence (around 30% or lower)
- [ ] Status shows "Needs Review" (amber)
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Enrich Again
1. Enrich a contact that was already enriched before
2. Click "AI Enrich" again

**Expected:** Re-enrichment runs and may update/refine previous results.

- [ ] Re-enrichment works without error
- [ ] Previous results are replaced with new ones
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Check Enriched Data Fields
1. After a successful enrichment, verify each field displayed:
   - Title, Company, Industry, Location
   - Relevance badge (High/Medium/Low with color)
   - Contact Type badge (e.g., "Founder / Owner", "Investment Banker")
   - LinkedIn link ("Find on LinkedIn")
   - Expertise tags (small pills)
   - Linked Deals
   - Document mentions

**Expected:** Fields that the AI could determine are displayed. Empty fields are simply omitted (not shown as "N/A").

- [ ] Fields display correctly when present
- [ ] Empty fields are hidden (not shown)
- [ ] LinkedIn link opens in new tab
- [ ] Expertise tags are styled as pills
- [ ] Pass / Fail

**Notes:** ___

#### Test 5: Error Handling
1. Try enriching with a contact that might cause issues (if possible, disconnect from internet briefly)
2. Or wait for any natural API error

**Expected:** Error notification appears (red): "Error — [error message]". Button resets to normal state (not stuck on "Enriching...").

- [ ] Error shows as red toast notification
- [ ] Button resets to "AI Enrich" (not stuck)
- [ ] Pass / Fail

**Notes:** ___

---

## 4. Data Room (VDR)

### 4.1 AI Quick Insights

**What it does:** AI analyzes all documents in a folder and provides: a completeness percentage, a summary of what's in the folder, red flags (missing or problematic documents), and a list of missing documents.

**Where:** Open any deal → click **"Data Room"** tab → select a folder from the left sidebar → the **"AI Quick Insights"** panel appears on the right side

#### Test 1: Generate Insights for a Folder
1. Open a deal's Data Room
2. Click on a folder that has some documents in it (e.g., "Financials")
3. Look for the right-side panel labeled **"AI Quick Insights"** (it may be collapsed — click the thin bar on the far right to expand it)
4. If no insights exist yet, click **"Generate AI Insights"** button (blue, centered)
5. Wait for loading (spinner + "Analyzing folder... GPT-4o is scanning documents and generating insights")

**Expected:**
- Completeness progress bar (green ≥80%, amber 50-79%, red <50%)
- Summary text describing folder contents
- Red Flags section (if any — each with severity icon and description)
- Missing Documents section (if any — with "Request" button per item)

- [ ] Panel expands when clicked
- [ ] "Generate AI Insights" button is visible for folders without insights
- [ ] Loading spinner shows during generation
- [ ] Completeness % bar appears with correct color
- [ ] Summary is relevant to folder contents
- [ ] Red flags listed with severity icons (if applicable)
- [ ] Missing documents listed (if applicable)
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Refresh Insights
1. After insights are showing, click the **refresh (🔄) icon** at the top-right of the insights panel
2. Insights should regenerate

**Expected:** New insights replace old ones. May show different completeness % if documents changed.

- [ ] Refresh triggers new analysis
- [ ] Updated insights appear
- [ ] Pass / Fail

**Notes:** ___

#### Test 3: Empty Folder
1. Select a folder with no documents
2. Try to generate insights

**Expected:** Either shows a message that the folder is empty, or generates insights noting 0% completeness and all documents are missing.

- [ ] Handles empty folder gracefully
- [ ] Pass / Fail

**Notes:** ___

#### Test 4: Request Missing Document
1. After insights show missing documents, click the **"Request"** button next to any missing doc
2. This should trigger a document request (email or in-app notification)

**Expected:** Request is sent. Some feedback shown (toast notification or confirmation).

- [ ] Request button is clickable
- [ ] Some confirmation of request sent
- [ ] Pass / Fail

**Notes:** ___

---

### 4.2 Generate Full Report

**What it does:** Generates a comprehensive report for the entire folder based on AI analysis.

**Where:** Bottom of the AI Quick Insights panel → **"Generate Full Report"** button (dark blue)

#### Test 1: Generate Report
1. After folder insights are showing, scroll to the bottom of the insights panel
2. Click **"Generate Full Report"**

**Expected:** Either generates a downloadable report or opens an expanded view with detailed analysis.

- [ ] Button is visible at bottom of insights panel
- [ ] Report generates or navigates to detailed view
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Report Without Insights
1. Try clicking "Generate Full Report" before generating insights first (if the button is visible)

**Expected:** Should either generate insights first, or prompt user to generate insights before the report.

- [ ] Handled gracefully
- [ ] Pass / Fail

**Notes:** ___

---

## 5. Memo Builder (⚠️ Partially Built)

**Important:** The Memo Builder is partially built. Some features may work end-to-end while others may be UI-only (show the interface but don't connect to the backend). Document what works and what doesn't.

**Where:** Navigate to the Memo Builder page (look for "AI Reports" in the sidebar, or navigate via lmmos.ai/memo-builder)

### 5.1 AI Section Generation

**What it does:** AI generates content for individual memo sections (Executive Summary, Financial Performance, Market Dynamics, Risk Assessment, Deal Structure).

**Where:** In the memo editor, each section has action icons that appear on hover — look for the **regenerate (🔄) icon**. When adding a new section, there's a **"Generate content with AI"** checkbox.

#### Test 1: Regenerate Existing Section
1. Open or create a memo
2. Click on a section (e.g., "Executive Summary")
3. Look for action icons above the section title
4. Click the **🔄 (regenerate) icon**

**Expected:** Section content is regenerated by AI. Chat panel may show a message like "Regenerating Executive Summary". New content replaces old.

- [ ] Regenerate icon is visible/clickable
- [ ] AI generates new content for the section
- [ ] Content appears in the editor
- [ ] Pass / Fail
- [ ] Or: Feature is UI-only / not connected

**Notes:** ___

#### Test 2: Add New Section with AI
1. Click **"+ Add Section"** at the bottom of the sections sidebar
2. In the modal, select a section type (e.g., "Market Dynamics")
3. Check the **"Generate content with AI"** checkbox
4. Click create/add

**Expected:** New section is created AND AI content is generated for it.

- [ ] "Generate with AI" checkbox exists
- [ ] AI content generated for new section
- [ ] Pass / Fail
- [ ] Or: Feature is UI-only / not connected

**Notes:** ___

#### Test 3: Delete and Recreate Section
1. Click the **🗑️ (delete) icon** on a section
2. Confirm deletion
3. Add the section back with AI generation

**Expected:** Section deletes cleanly, chat confirms deletion. New section can be created with fresh AI content.

- [ ] Delete works with confirmation
- [ ] Chat shows deletion message
- [ ] Pass / Fail

**Notes:** ___

---

### 5.2 AI Analyst Chat

**What it does:** Chat panel on the right side for iterative memo refinement. Ask AI to rewrite sections, add analysis, change tone, or generate charts.

**Where:** Memo Builder → right panel labeled **"AI Analyst"** with a blue gradient icon. Input says **"Ask AI to analyze, rewrite, or visualize data..."**

#### Test 1: Send a Chat Message
1. In the AI Analyst panel (right side), type: **"Summarize the financial performance section"**
2. Click send or press Enter

**Expected:** AI responds in the chat with relevant summary. Typing indicator (three dots) shows while processing.

- [ ] Chat input accepts text
- [ ] Typing indicator shows
- [ ] AI response appears with timestamp
- [ ] Response is relevant
- [ ] Pass / Fail
- [ ] Or: Feature is UI-only / not connected

**Notes:** ___

#### Test 2: Use Prompt Chips
1. Look for pre-built suggestion chips below the chat input (e.g., "Rewrite for Tone", "EBITDA Bridge", "Revenue Growth")
2. Click on one of them

**Expected:** The chip's text is sent as a message and AI responds accordingly.

- [ ] Prompt chips are visible
- [ ] Clicking a chip sends it as a message
- [ ] AI responds to the chip prompt
- [ ] Pass / Fail
- [ ] Or: Feature is UI-only / not connected

**Notes:** ___

#### Test 3: File Attachment in Chat
1. Click the **📎 (paperclip) icon** in the chat input area
2. Select a document

**Expected:** Document reference appears in chat. AI acknowledges and can analyze the file.

- [ ] File picker opens
- [ ] File reference shown in chat
- [ ] AI acknowledges the file
- [ ] Pass / Fail
- [ ] Or: Feature is simulated / not connected

**Notes:** ___

---

### 5.3 Compliance Check

**What it does:** Verifies that citations in the memo match source documents in the Data Room.

**Where:** Memo Builder → bottom of the left sidebar → green badge that says **"Compliance Check — All citations are verified against the data room"**

#### Test 1: Check Badge Presence
1. Open a memo
2. Look at the bottom of the left sidebar

**Expected:** Green badge with check icon is visible.

- [ ] Compliance check badge is displayed
- [ ] Badge is green with check icon
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Citation Links
1. In a section with AI-generated content, look for inline citation buttons (e.g., "CIM p.14" in a blue button)
2. Click on a citation

**Expected:** Either opens the source PDF at the cited page, or shows a notification about the source.

- [ ] Citation buttons are visible in AI-generated content
- [ ] Clicking opens source document or shows source info
- [ ] Pass / Fail
- [ ] Or: Feature is UI-only / not connected

**Notes:** ___

---

### 5.4 Export to PDF

**What it does:** Exports the full memo (with all AI-generated content, tables, charts) to a PDF file.

**Where:** Memo Builder → top-right → **"Export to PDF"** button (blue, with dropdown arrow)

#### Test 1: Export Memo
1. Open a memo with some content
2. Click **"Export to PDF"**

**Expected:** PDF file downloads with the memo content including header (project name, date, sponsor), all sections, tables, and footer.

- [ ] PDF downloads successfully
- [ ] Content matches what's shown in the editor
- [ ] Formatting is clean and readable
- [ ] Pass / Fail

**Notes:** ___

#### Test 2: Export Empty Memo
1. Create a new empty memo (no sections filled)
2. Try to export

**Expected:** Either exports an empty/skeleton PDF, or shows a message that there's nothing to export.

- [ ] Handled gracefully (no crash)
- [ ] Pass / Fail

**Notes:** ___

---

## Team Notes & Known Limitations

These are NOT bugs — do not report these:

1. **Contact Enrichment confidence caps** — If a contact only has a name (no email, no company), the confidence score will be capped at ~30%. This is by design to ensure honest scoring.

2. **Portfolio page is "Coming Soon"** — Clicking "Portfolio" in the sidebar goes to a "Coming Soon" page. This is expected.

3. **AI Market Sentiment widget on Dashboard** — This is currently hardcoded/static data. It will be removed or made dynamic in a future update. Not a priority for testing.

4. **Dashboard customization** — There is no way to toggle widgets on/off yet. This is a planned future feature.

5. **Memo Builder partial implementation** — Some features may show the UI but not connect to the backend. Document what works vs. what doesn't — this helps us prioritize what to finish.

6. **VDR Data Checklist** — Currently the VDR insights show missing documents, but a proper checklist for tracking received documents is a future enhancement.

7. **"AI can make mistakes"** disclaimer — This appears below the chat input on Deal Chat and Memo Chat. This is intentional.

8. **Deal Chat says "Avise AI • GPT-4"** — Even though the backend may use GPT-4o, the label says GPT-4. This is cosmetic.

---

## Test Summary Scorecard

Fill this out after completing all tests:

| Section | Total Tests | Passed | Failed | Notes |
|---------|-------------|--------|--------|-------|
| 1.1 Portfolio Signal Monitor | 4 | | | |
| 1.2 Portfolio Chat | 5 | | | |
| 2.1 Deal Chat AI | 6 | | | |
| 2.2 Meeting Prep | 4 | | | |
| 2.3 Email Drafter | 5 | | | |
| 2.4 Financial Extraction | 4 | | | |
| 2.5 AI Financial Analysis | 5 | | | |
| 3.1 Contact Enrichment | 5 | | | |
| 4.1 AI Quick Insights | 4 | | | |
| 4.2 Generate Full Report | 2 | | | |
| 5.1 AI Section Generation | 3 | | | |
| 5.2 AI Analyst Chat | 3 | | | |
| 5.3 Compliance Check | 2 | | | |
| 5.4 Export to PDF | 2 | | | |
| **TOTAL** | **54** | | | |

**Tested by:** ___
**Date:** ___
**Overall Status:** READY FOR LOOM / NEEDS FIXES
