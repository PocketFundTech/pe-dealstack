# Avise — Security Testing Checklist

**For:** QA Team / Founders
**Purpose:** Verify all security features are working before running real deal data
**Time needed:** ~30 minutes

---

## Quick Summary — What We Built & Why

Avise now has **6 layers of security** protecting deal data:

1. **Private Document Storage** — All deal files (CIMs, financials, legal) are locked behind authentication. No one can access them with just a URL.
2. **Signed URLs** — When you preview/download a document, you get a temporary link that expires in 1 hour. Can't be bookmarked or shared permanently.
3. **Two-Factor Authentication (2FA)** — Optional TOTP via Google Authenticator / Authy. After entering your password, you need a 6-digit code from your phone.
4. **Organization Isolation** — Org A can never see Org B's data. Every single API endpoint checks this. 34 automated tests verify it.
5. **Security Headers** — Protection against clickjacking, XSS escalation, MIME sniffing attacks (handled automatically by the server).
6. **Strong Passwords** — Minimum 10 characters with uppercase, lowercase, number, AND special character.

**Infrastructure:** Everything runs on SOC 2 Type II certified providers (Supabase, Vercel, OpenAI). Database is encrypted at rest with AES-256.

---

## Test Checklist

### 1. Document Access (Private Bucket + Signed URLs)

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 1.1 | Document preview works | Login → Open any deal → Click a document | Document preview loads normally | |
| 1.2 | Document download works | Login → Deal → Click document → Download | File downloads successfully | |
| 1.3 | Old public URLs don't work | Copy a document URL from the browser → Open in incognito/private window | Should get 400/403 error, NOT the document | |
| 1.4 | Signed URL expires | Download a document → Copy the signed URL from network tab → Wait 1+ hour → Try the URL again | Should fail after expiry | |
| 1.5 | Logout blocks access | Download a document → Logout → Try the signed URL | Should still work (it's time-limited, not session-bound) — this is expected | |

### 2. Two-Factor Authentication (MFA/2FA)

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 2.1 | Enable 2FA | Login → Settings → Security → Click "Enable" under Two-Factor Authentication | QR code appears | |
| 2.2 | Scan QR code | Open Google Authenticator / Authy → Scan the QR code | App shows "Avise" with 6-digit rotating code | |
| 2.3 | Verify enrollment | Enter the 6-digit code from your authenticator app → Click "Verify & Enable 2FA" | Success message, status shows "Enabled" | |
| 2.4 | Login with 2FA | Logout → Login with email + password | After password, shows 6-digit code input screen | |
| 2.5 | Correct code works | Enter correct 6-digit code from authenticator | Redirected to CRM dashboard | |
| 2.6 | Wrong code rejected | Enter wrong 6-digit code (e.g., 000000) | Error message "Invalid code", inputs cleared | |
| 2.7 | Back button works | On 2FA screen → Click "Back to sign in" | Returns to password login (signs you out) | |
| 2.8 | Paste code works | Copy code from authenticator → Paste into first digit box | All 6 digits fill automatically | |
| 2.9 | Disable 2FA | Settings → Security → Click "Disable" → Confirm | 2FA removed, next login skips 2FA step | |

### 3. Password Policy

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 3.1 | Short password rejected | Signup → Enter "Pass1!" (7 chars) | Error: must be at least 10 characters | |
| 3.2 | No special char rejected | Signup → Enter "Password123" (no special) | Error: must contain special character | |
| 3.3 | Valid password accepted | Signup → Enter "MyStr0ng!Pass" | Password accepted, strength shows "Strong" | |
| 3.4 | Settings password change | Settings → Security → Change Password → Enter weak password | Validation rules show red indicators | |

### 4. Organization Isolation

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 4.1 | Can't see other org's deals | Login as Org A → Note a deal ID → Login as Org B → Try `/api/deals/{orgA-deal-id}` | Returns 404 (not the deal data) | |
| 4.2 | Can't see other org's documents | Same as above but with document ID | Returns 404 | |
| 4.3 | Can't see other org's contacts | Same as above but with contact ID | Returns 404 | |
| 4.4 | Own data works fine | Login → View your own deals, documents, contacts | Everything loads normally | |

### 5. Security Headers

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 5.1 | Headers present | Open browser DevTools → Network tab → Click any API call → Check Response Headers | Should see: `content-security-policy`, `strict-transport-security`, `x-content-type-options: nosniff`, `x-frame-options: DENY` | |

### 6. Upload Security

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 6.1 | PDF upload works | Deal → Data Room → Upload a PDF | Upload succeeds, document appears | |
| 6.2 | Excel upload works | Deal → Data Room → Upload an .xlsx file | Upload succeeds | |
| 6.3 | Executable rejected | Try uploading a .exe file (rename to .pdf if needed) | Upload rejected — file validation detects it's not a real PDF | |
| 6.4 | Large file limit | Try uploading a file > 100MB | Upload rejected with size limit error | |

### 7. Audit Trail

| # | Test | Steps | Expected Result | Pass? |
|---|------|-------|-----------------|-------|
| 7.1 | Document download logged | Download a document → Check audit log (Admin → Audit Log) | Entry shows DOCUMENT_DOWNLOADED with your name, document name, timestamp | |
| 7.2 | Login tracked | Login → Check audit log | Entry shows LOGIN event | |

---

## Test Results Summary

| Category | Tests | Passed | Failed | Notes |
|----------|-------|--------|--------|-------|
| Document Access | 5 | | | |
| Two-Factor Auth | 9 | | | |
| Password Policy | 4 | | | |
| Org Isolation | 4 | | | |
| Security Headers | 1 | | | |
| Upload Security | 4 | | | |
| Audit Trail | 2 | | | |
| **Total** | **29** | | | |

**Tested by:** _______________
**Date:** _______________
**Build/Commit:** _______________

---

## Quick Reference Card

### For the team — what changed and why

| Before | After | Why |
|--------|-------|-----|
| Documents had public URLs anyone could access | Documents require login + get temporary 1-hour links | Real CIMs and financials need access control |
| Password: 8 chars, no special character | Password: 10 chars + uppercase + lowercase + number + special | Industry standard for financial software |
| No 2FA option | TOTP 2FA via Google Authenticator / Authy | Table stakes — any PE compliance officer will ask |
| Some database tables had no access policies | Row-Level Security on ALL tables | Even if someone gets the database key, they need a valid user account |
| No security headers | CSP, HSTS, X-Frame-Options, nosniff | Prevents clickjacking and script injection attacks |
| Backend used same key as frontend | Backend uses separate privileged key | Frontend key can't bypass security even if leaked |
| Document downloads not tracked | Every download logged with who/when/what | Audit trail for compliance |

### What to tell customers

> "Avise encrypts all data at rest (AES-256) and in transit (TLS 1.2+). Documents are stored in private cloud storage with time-limited access links. We offer two-factor authentication, role-based access control, and maintain a complete audit trail of all document access. Our infrastructure providers (Supabase, Vercel, OpenAI) are all SOC 2 Type II certified."
