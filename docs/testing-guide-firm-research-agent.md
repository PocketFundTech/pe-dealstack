# Testing Guide: Firm Research Agent

Manual testing guide for the AI-powered firm research and enrichment agent.

---

## Prerequisites

- A modern browser (Chrome, Firefox, Safari, or Edge)
- Access to the Avise staging/production environment
- A user account (new or existing)
- Internet connectivity (the agent scrapes websites and runs DuckDuckGo searches)

**Expected response times:** Enrichment typically takes 15-25 seconds. The verify step (portfolio company cross-validation) may add 3-8 additional seconds.

---

## Test Scenarios

### 1. Real PE Firm Website Enrichment

**Steps:**
- [ ] Navigate to the onboarding flow (or Settings > Firm Profile)
- [ ] Enter a real PE firm website URL (e.g., `https://pocket-fund.com` or another known firm)
- [ ] Leave the LinkedIn field empty for this test
- [ ] Submit the form and wait for enrichment to complete (15-25 seconds)

**Expected result:**
- [ ] A loading/processing indicator appears while the agent runs
- [ ] After 15-25 seconds, enrichment results are displayed
- [ ] The firm's sectors are pre-filled with realistic values (matching the firm's actual focus areas)
- [ ] Fund size / check size range is populated (if available on the website)
- [ ] A firm description appears that accurately summarizes the firm
- [ ] Portfolio companies are listed (if the firm has a portfolio page)

**Result:** PASS / FAIL

---

### 2. LinkedIn URL Enrichment

**Steps:**
- [ ] In the onboarding flow or Settings, enter only a LinkedIn URL (e.g., `https://linkedin.com/in/someone-real`)
- [ ] Leave the website URL empty
- [ ] Submit and wait for results

**Expected result:**
- [ ] The agent finds person-related information (title, role, experience)
- [ ] Person profile fields are populated
- [ ] Since no website was provided, firm-level data may be sparse or based on search results only
- [ ] No errors are thrown

**Result:** PASS / FAIL

---

### 3. Full Enrichment (Website + LinkedIn)

**Steps:**
- [ ] Enter both a real PE firm website URL and a LinkedIn URL for someone at that firm
- [ ] Submit and wait for results

**Expected result:**
- [ ] Both FirmProfile and PersonProfile are populated
- [ ] The person's title matches their actual role at the firm
- [ ] The person-firm relationship is verified (person profile shows `verified: true` or equivalent indicator)
- [ ] Results are richer than either input alone

**Result:** PASS / FAIL

---

### 4. Invalid/Fake URL -- Graceful Error Handling

**Steps:**
- [ ] Enter a clearly fake website URL (e.g., `https://this-firm-does-not-exist-xyz123.com`)
- [ ] Submit and wait for the agent to complete

**Expected result:**
- [ ] The agent does not crash or show a raw error page
- [ ] A user-friendly message indicates that the website could not be reached or no data was found
- [ ] The manual form fields remain editable -- the user can still fill in information by hand
- [ ] The onboarding flow does not get stuck; the user can proceed to the next task

**Result:** PASS / FAIL

---

### 5. Enrichment Accuracy -- Cross-Check with Firm Website

**Steps:**
- [ ] Run enrichment for a firm whose website you can manually verify
- [ ] Open the firm's actual website in a separate browser tab
- [ ] Compare the enrichment results field by field:
  - [ ] **Sectors:** Do they match what the firm says on their website?
  - [ ] **Strategy:** Is the investment strategy description accurate?
  - [ ] **Check size / AUM:** Do the numbers appear on the website?
  - [ ] **Headquarters:** Is the location correct?
  - [ ] **Team size:** Is this roughly accurate?
  - [ ] **Founded year:** Does it match?

**Expected result:**
- [ ] All populated fields should be traceable to content on the firm's website or public sources
- [ ] No hallucinated information (numbers, names, or facts not found in any source)
- [ ] Fields that could not be verified are left empty rather than guessed

**Result:** PASS / FAIL

---

### 6. Confidence Level Assessment

**Steps:**
- [ ] Run enrichment for a well-known PE firm with a detailed website (expect "high" confidence)
- [ ] Run enrichment for a small/new firm with minimal web presence (expect "medium" or "low" confidence)
- [ ] Compare the confidence levels

**Expected result:**
- [ ] Well-known firm with rich website: confidence is `high`
- [ ] Small/sparse firm: confidence is `medium` or `low`
- [ ] The confidence label is visible in the UI (as a badge or text)
- [ ] Lower confidence correlates with fewer populated fields

**Result:** PASS / FAIL

---

### 7. Portfolio Companies Verification

**Steps:**
- [ ] Run enrichment for a firm with a public portfolio page
- [ ] Check the portfolio companies listed in the results
- [ ] For each company:
  - [ ] Search the company name + firm name on Google to confirm the relationship
  - [ ] Note which companies are marked as `verified` vs `unverified`

**Expected result:**
- [ ] Listed portfolio companies should be real companies (not hallucinated names)
- [ ] Companies marked `verified: true` should have a confirmed co-occurrence online
- [ ] Companies marked `verified: false` may still be real, but could not be independently confirmed
- [ ] No completely fabricated company names appear

**Result:** PASS / FAIL

---

### 8. Settings Page -- Refresh Profile

**Steps:**
- [ ] Navigate to Settings after enrichment has been completed at least once
- [ ] Find the "Firm Profile" section
- [ ] Verify the current enrichment data is displayed
- [ ] Click the "Refresh" button
- [ ] Wait for re-enrichment to complete (15-25 seconds)

**Expected result:**
- [ ] A loading state appears on the button or section
- [ ] After 15-25 seconds, the profile data refreshes
- [ ] The "last enriched" timestamp updates to the current time
- [ ] Data may have minor changes if the firm's website was updated since last enrichment
- [ ] No errors are thrown

**Result:** PASS / FAIL

---

### 9. Deal Chat -- Firm Context Integration

**Steps:**
- [ ] Ensure enrichment has been completed for your firm (check Settings > Firm Profile)
- [ ] Open a deal page and navigate to the Chat tab
- [ ] Ask: "Does this deal match our investment criteria?"
- [ ] Ask: "How does this company compare to our portfolio?"
- [ ] Ask: "Is this deal in our target sector?"

**Expected result:**
- [ ] The AI responds with references to your firm's specific strategy, sectors, and criteria
- [ ] Responses mention your firm's check size range or fund size when relevant
- [ ] Portfolio company comparisons reference actual portfolio companies from your profile
- [ ] The AI does not give generic answers -- it uses your firm's specific context
- [ ] If no firm profile exists, the AI should still give a reasonable answer (just without firm-specific context)

**Result:** PASS / FAIL

---

### 10. Rate Limiting -- 4th Enrichment Should Fail

**Steps:**
- [ ] Run enrichment 3 times within one hour (using the Settings refresh button or onboarding)
- [ ] On the 4th attempt, click "Refresh" again

**Expected result:**
- [ ] The 1st, 2nd, and 3rd enrichments complete successfully
- [ ] The 4th attempt shows a clear error message: "Rate limit exceeded. Maximum 3 enrichments per hour."
- [ ] The UI does not crash or show a raw error
- [ ] After waiting (up to 1 hour from the first enrichment), the limit resets and enrichment works again

**Result:** PASS / FAIL

---

## Summary

| # | Scenario | Result |
|---|---|---|
| 1 | Real PE firm website enrichment | |
| 2 | LinkedIn URL enrichment | |
| 3 | Full enrichment (website + LinkedIn) | |
| 4 | Invalid/fake URL -- graceful error | |
| 5 | Enrichment accuracy cross-check | |
| 6 | Confidence level assessment | |
| 7 | Portfolio companies verification | |
| 8 | Settings -- refresh profile | |
| 9 | Deal Chat -- firm context integration | |
| 10 | Rate limiting (4th enrichment fails) | |

**Tester:** _______________
**Date:** _______________
**Environment:** Staging / Production
**Browser:** _______________
