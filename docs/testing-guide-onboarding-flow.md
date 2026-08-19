# Testing Guide: Onboarding Flow

Manual testing guide for the new user onboarding experience.

---

## Prerequisites

- A modern browser (Chrome, Firefox, Safari, or Edge)
- Access to the Avise staging/production environment
- A **new email address** that has not been used to sign up before (each test requires a fresh account)
- Optionally: a second email address to test team invitations

---

## Test Scenarios

### 1. New User Signup Redirects to Onboarding

**Steps:**
- [ ] Navigate to `/signup.html`
- [ ] Verify the signup page shows: Full Name, Email, Firm Name, Password fields
- [ ] Verify there is NO "Title" dropdown (it was removed)
- [ ] Fill in all fields with a new email and firm name
- [ ] Click "Create Account"
- [ ] Wait for account creation to complete

**Expected result:**
- [ ] Account is created successfully (no errors)
- [ ] Browser redirects to `/onboarding.html` (NOT to dashboard)
- [ ] The onboarding welcome screen is displayed

**Result:** PASS / FAIL

---

### 2. Welcome Screen -- "Let's go" Button

**Steps:**
- [ ] On the welcome screen, verify the 2-column layout: hero text on the left, checklist preview on the right
- [ ] Verify the firm name or user name appears in the welcome message
- [ ] Click the "Let's go" button

**Expected result:**
- [ ] The view transitions to the checklist with 3 tasks visible
- [ ] Task 1 ("Define your investment focus") is highlighted as the active task
- [ ] Tasks 2 and 3 are dimmed/pending

**Result:** PASS / FAIL

---

### 3. Welcome Screen -- "Use a sample deal"

**Steps:**
- [ ] If there is a "Use a sample deal" option on the welcome screen, click it

**Expected result:**
- [ ] A sample deal is loaded or the user is taken to a pre-populated deal view
- [ ] The onboarding flow progresses appropriately (Task 2 may be auto-completed)

**Result:** PASS / FAIL

---

### 4. Task 1: Define Investment Focus

**Steps:**
- [ ] On Task 1, verify the form shows fields for: Website URL, LinkedIn URL, Fund Size, Sectors
- [ ] Enter a real PE firm website (e.g., `https://pocket-fund.com`)
- [ ] Enter a LinkedIn profile URL
- [ ] Select or type fund size and sectors
- [ ] Click the "Done" or "Next" button to mark the task complete

**Expected result:**
- [ ] The form accepts all inputs without errors
- [ ] An enrichment request is triggered in the background (may show a brief loading indicator)
- [ ] Task 1 circle changes to a green checkmark
- [ ] The view advances to Task 2
- [ ] Task 1 row shows as completed (strikethrough text, muted colors)

**Result:** PASS / FAIL

---

### 5. Task 2: Upload Your First Deal

**Steps:**
- [ ] On Task 2, verify a file dropzone is visible
- [ ] Drag and drop a PDF (CIM or any document) onto the dropzone
- [ ] Alternatively, click the dropzone to open a file picker and select a file
- [ ] Wait for the upload to complete
- [ ] If sample deals are offered, click one of them instead

**Expected result:**
- [ ] File upload shows progress and completes successfully
- [ ] Task 2 circle changes to a green checkmark
- [ ] The view advances to Task 3
- [ ] If a sample deal was selected, it loads without requiring a file upload

**Result:** PASS / FAIL

---

### 6. Task 3: Invite Your Team (Optional)

**Steps:**
- [ ] On Task 3, verify email + role input rows are shown
- [ ] Add a team member: enter an email address and select a role (MEMBER, VIEWER, or ADMIN)
- [ ] Click "Add another" to add a second row
- [ ] Remove one row by clicking the remove/X button
- [ ] Click "Done" or "Skip" to proceed

**Expected result:**
- [ ] Email input accepts valid email formats
- [ ] Role dropdown shows the 3 options
- [ ] Adding rows works (new row appears)
- [ ] Removing rows works (row disappears, remaining rows stay)
- [ ] Skipping is allowed -- the task is optional
- [ ] If invitations were sent, they appear in the Settings > Team section later

**Result:** PASS / FAIL

---

### 7. Completion Screen -- Dynamic Findings

**Steps:**
- [ ] After completing all 3 tasks (or skipping Task 3), verify the completion screen appears
- [ ] Check if the screen shows enrichment findings (sectors, fund size, portfolio companies, person title)
- [ ] If the agent is still running, verify a "processing" or "researching" spinner is shown
- [ ] Wait for findings to appear (may take 15-25 seconds)
- [ ] Verify confetti animation plays on the screen

**Expected result:**
- [ ] Completion screen displays with a congratulatory message
- [ ] Dynamic findings from the firm research agent are shown (or a processing state)
- [ ] Findings match the actual firm's website data (sectors, fund size should be realistic)
- [ ] Confetti animation is visible

**Result:** PASS / FAIL

---

### 8. "Open Your Deal" Button Navigation

**Steps:**
- [ ] On the completion screen, click the "Open your deal" button (visible if a deal was uploaded in Task 2)

**Expected result:**
- [ ] Browser navigates to `/deal.html?id=<dealId>` for the deal that was just created
- [ ] The deal page loads with the uploaded document visible in the VDR
- [ ] If no deal was uploaded (sample deal path), the button still navigates to the correct deal

**Result:** PASS / FAIL

---

### 9. Skip Setup -- Goes to Dashboard

**Steps:**
- [ ] Create another fresh account (or reset onboarding state)
- [ ] On the welcome screen, click "Skip setup" (or equivalent skip button)

**Expected result:**
- [ ] Browser navigates to `/dashboard.html`
- [ ] Dashboard loads normally without errors
- [ ] Onboarding is not shown again on subsequent visits (onboarding status is marked as skipped)

**Result:** PASS / FAIL

---

### 10. Returning User -- Does Not See Onboarding Again

**Steps:**
- [ ] Log in with an account that already completed onboarding
- [ ] Navigate to `/dashboard.html`
- [ ] Try navigating directly to `/onboarding.html`

**Expected result:**
- [ ] Dashboard loads normally, no onboarding redirect
- [ ] If navigating directly to `/onboarding.html`, the user is redirected away (to dashboard) since onboarding is already complete
- [ ] The onboarding checklist widget may still appear in the sidebar (showing completed status)

**Result:** PASS / FAIL

---

### 11. Settings -- Onboarding Checklist Persists

**Steps:**
- [ ] After completing onboarding, navigate to Settings
- [ ] Look for the onboarding checklist or firm profile section in the sidebar or settings page

**Expected result:**
- [ ] Completed onboarding steps are reflected in the settings/sidebar
- [ ] The firm profile section shows enriched data (if enrichment completed)
- [ ] Checklist items show as completed with green checkmarks

**Result:** PASS / FAIL

---

## Summary

| # | Scenario | Result |
|---|---|---|
| 1 | New user signup redirects to onboarding | |
| 2 | Welcome screen -- "Let's go" button | |
| 3 | Welcome screen -- "Use a sample deal" | |
| 4 | Task 1: Define investment focus | |
| 5 | Task 2: Upload deal | |
| 6 | Task 3: Invite team (optional) | |
| 7 | Completion screen -- dynamic findings | |
| 8 | "Open your deal" navigation | |
| 9 | Skip setup goes to dashboard | |
| 10 | Returning user skips onboarding | |
| 11 | Settings checklist persistence | |

**Tester:** _______________
**Date:** _______________
**Environment:** Staging / Production
**Browser:** _______________
