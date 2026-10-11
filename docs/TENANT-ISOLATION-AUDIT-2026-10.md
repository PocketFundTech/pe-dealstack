# Tenant isolation audit, October 2026

**Date:** 2026-10-12. **Base:** `origin/main` @ `ddec3f0c`. **Branch:** `fix/tenant-isolation-audit-2026-10`

**Question:** can a user (or API key) in one firm read or change another firm's data through the API?

**Answer:**

- **Before this PR: yes, in a few places.** Every hole needed the attacker to already know a UUID belonging to the other firm. These ids are never shown across firms, so none of them works by guessing. The holes were still real:
  - read leaks: another firm's company record, deal name and stage, and deal financials and documents through a memo;
  - writes: planting files in another firm's data room, renaming its company, marking its NDAs signed.
- **After this PR: no open cross-firm hole is known in `apps/api/src/routes`.** One cross-firm item is left open (OAuth account-connection CSRF, see "Open, not fixed here"). It needs a victim to click a link, and fixing it needs a frontend cookie change.

**Method:**

- Re-checked all 24 findings in `.planning/codebase/UNGUARDED_SELECTS_AUDIT.md` (May 2026) against current code.
- Swept every handler in all 118 route files, reading each one. Where a route passes a user-supplied id into a service, the service was read too.
- Every fix below has a regression test. Each test's attack case was confirmed **red against `origin/main`** and green with the fix.

**Trust model reminder:** the API uses the Supabase service-role client, and RLS is deny-all. Org isolation is enforced **only** in Express code: `getOrgId`, `verify*Access` in `middleware/orgScope.ts`, and `.eq('organizationId', orgId)`.

---

## 1. May 2026 audit findings: current status

| ID | Route | Status |
|---|---|---|
| F-1 | `GET /api/activities/:id` | Already fixed (PR #75). Parent deal verified. Test: `activities-security.test.ts` |
| F-2 | `GET /api/activities/recent` | Already fixed (#75). `Deal!inner` + `deal.organizationId` filter |
| F-3 | `GET /api/users/:id/notifications` | Already fixed (#75). Target user must be in caller org. Test: `users-notifications-security.test.ts` |
| F-4 | `POST /api/deals/:id/analyze` | Already fixed (#75). `verifyDealAccess`. Test: `deals-analysis-security.test.ts` |
| F-5 | `POST /api/ingest` body `dealId` | Already fixed (#75). `verifyDealAccess` before merge. Test: `ingest-upload-security.test.ts` |
| F-6 | `POST /api/ingest/text`, `/url` body `dealId` | Already fixed (#75). Tests: `ingest-text-security.test.ts`, `ingest-url.test.ts` |
| F-7 | `PATCH /api/memos/:id/sections/:sectionId` | Already fixed (#77). `.eq('memoId', id)`. Test: `memos-sections-security.test.ts` |
| F-8 | `DELETE /api/memos/:id/sections/:sectionId` | Already fixed (#77) |
| F-9 | `POST /api/memos/:id/sections/reorder` | Already fixed (#77) |
| F-10 | `POST /api/memos/:id/sections/:sectionId/generate` | Already fixed (#77). Test: `memos-chat-security.test.ts` |
| F-11 | `PATCH /api/templates/:id/sections/:sectionId` | Already fixed (#77). Test: `templates-sections-security.test.ts` |
| F-12 | `DELETE /api/templates/:id/sections/:sectionId` | Already fixed (#77) |
| F-13 | `POST /api/templates/:id/sections/reorder` | Already fixed (#77) |
| F-14 | `DELETE /api/activities/:id` | Already fixed (#75) |
| F-15 | `POST /api/contacts/:id/connections` `relatedContactId` | Already fixed. `verifyContactAccess`. Test: `contacts-connections-security.test.ts` |
| F-16 | `DELETE /api/contacts/:id/connections/:connectionId` | Already fixed. Bound with `.or(contactId/relatedContactId = id)` |
| **F-17** | `GET/DELETE /api/conversations/:id`, `POST /api/conversations/:id/messages` with a **deal-less** conversation | **Fixed in this PR.** Was still open: a conversation with no `dealId` skipped the org check entirely, so anyone could read, post into or delete it by id. Deal-less conversations are now owned through `Conversation.userId → User.organizationId`, and `POST /api/conversations` refuses a `userId` from another org. Test: `chat-conversations-security.test.ts` |
| F-18 | `POST /api/memos` deal-name leak (known P3) | Already fixed. Deal lookup is org-scoped; returns 400 on a foreign deal. Test: `memos-create-security.test.ts` |
| F-19 | `POST /api/memos` template clone + `POST /api/templates/:id/use` RPC (known P3) | Already fixed. Both verify the template's org before cloning, incrementing or calling the RPC |
| F-20 | `GET /api/users/:id/deals` | Already fixed. Test: `users-deals-security.test.ts` |
| F-21 | `GET /api/documents/alerts` global scan | Already fixed. Pre-fetches org deal ids and filters with `.in('dealId', …)` |
| F-22 | `POST/PATCH /api/tasks` `dealId` / `assignedTo` | Already fixed. Test: `tasks-security.test.ts` |
| F-23 | `POST /api/deals/:id/team` `userId` | Already fixed. Test: `deals-team-security.test.ts` |
| F-24 | `POST /api/deals/:dealId/financials/resolve` `chosenVersionId` | Already fixed. Must be in this deal's version set. Test: `financials-merge-security.test.ts` |

## 2. New findings from the October sweep (routes added or changed since July)

| ID | Severity | Route | Hole | Status |
|---|---|---|---|---|
| N-1 | **HIGH** (read leak) | `PATCH /api/memos/:id` | `updateMemoSchema` is `createMemoSchema.partial()`, so it keeps `dealId`, but the F-18 check only ran on POST. A user could re-point their own memo at another firm's deal. After that, `GET /memos/:id` embedded that deal's financials and documents, section generation and the memo agent read its `Document.extractedText` and `FinancialStatement`s, and the memo appeared on the other firm's share portal. | **Fixed.** Deal must be in the caller's org (400). Defence in depth: the portal memo query now also filters on `share.organizationId`. Tests: `memos-update-security.test.ts`, `portal-public.test.ts` |
| N-2 | **HIGH** (read leak) | `POST /api/deals` body `companyId` | Never checked. It linked the new deal to another firm's `Company`, whose full row (`company:Company(*)`) is embedded in every deal response. It also planted the deal in the other firm's company views. | **Fixed.** Company must be in the caller's org (400). Test: `deals-mutate-refs-security.test.ts` |
| N-3 | **HIGH** (cross-org write) | `POST /api/ingest/:dealId/review` | Renamed the deal's Company with `.eq('id', deal.companyId)` only. Combined with N-2, this renamed another firm's company. | **Fixed.** Company and Deal updates now filter on `organizationId`. Test: `ingest-review-security.test.ts` |
| N-4 | MEDIUM (minor leak) | `POST /api/deals`, `PATCH /api/deals/:id` body `assignedTo` | A foreign user id leaked that user's name and email through the `assignedUser` embed, and routed stage-change emails about this firm's deal to them. | **Fixed.** Assignee must be in the caller's org (400). Same test file as N-2 |
| N-5 | **HIGH** (cross-org write) | `PATCH /api/documents/:id` body `folderId` | Not bound to the document's deal. It planted the file in another firm's data-room folder (folder listing, folder AI insights) and echoed back the foreign folder's name. | **Fixed.** Folder must belong to the document's deal. Test: `vdr-folder-binding-security.test.ts` |
| N-6 | **HIGH** (cross-org write) | `POST /api/deals/:dealId/documents` (+ `/from-drive`) body `folderId` | Same as N-5, on upload. | **Fixed.** Folder must belong to the URL's deal. Test: `documents-upload-background.test.ts` |
| N-7 | LOW (integrity) | `POST /api/deals/:dealId/folders`, `PATCH /api/folders/:id` body `parentId` | Could hang a folder under another firm's folder. No read path exposed it. | **Fixed.** Parent must be in the same deal. Test: `vdr-folder-binding-security.test.ts` |
| N-8 | MEDIUM (minor leak) | `POST /api/notifications` body `dealId` / `documentId` | Only `userId` was checked. The notification list embeds `Deal(id, name, stage)`, so a foreign deal's name and stage leaked. | **Fixed.** Returns 403 unless both are in the caller's org. Test: `notifications-create-refs-security.test.ts` |
| N-9 | MEDIUM (cross-org write, needs one captured event) | `POST /api/webhooks/dropbox-sign` | Dropbox Sign's `event_hash` only signs `event_time + event_type`, so the body (`signature_request_id`, `metadata.legalDocumentId`, `metadata.organizationId`) is unauthenticated. A replayed valid hash with a forged body could mark **any** firm's legal document SIGNED and attach a PDF from the attacker's own signature request. | **Fixed.** The event's `signature_request_id` must equal the one stored on the document when we sent it. Test: `dropbox-sign-event-binding.test.ts` |

### Same-firm hardening also fixed here (cheap, found during the sweep)

| ID | Severity | Route | Fix |
|---|---|---|---|
| S-1 | HIGH (privilege escalation inside a firm) | `POST /api/invitations/bulk` | Any MEMBER (or full-scope API key) could bulk-invite an address of their own as **ADMIN**. The single-invite route already blocked this; bulk did not. Same guard added. Test: `invitations-bulk-deals.test.ts` |
| S-2 | MEDIUM (blind SSRF, admin-only) | `PATCH /api/organizations/me/staff-access-webhook` | Saving a URL makes the server POST a test event to it, and private/metadata addresses were accepted. Now refuses private URLs (same rule as webhook-subscriptions). Test: `org-staff-webhook-ssrf.test.ts` |
| S-3 | LOW | `POST /api/cron/signal-scan` | The only cron without an unset-secret guard. With `CRON_SECRET` missing, `Bearer undefined` was accepted. Now fails closed like the other six. Test: `cron-secret-misconfig.test.ts` |

## 3. Open, not fixed here (follow-ups)

| Severity | Item | Why not here |
|---|---|---|
| MEDIUM, cross-firm (needs social engineering) | **OAuth account-connection CSRF.** The OAuth `state` is HMAC-signed with a 10-minute TTL, so it can't be forged for another org. It is not bound to the browser that started the flow, though. A firm-B user can send their own Gmail/Outlook/Calendar connect URL to a victim, and if the victim consents, the victim's mailbox tokens are stored on firm B's integration. Files: `integrations/_platform/oauth.ts`, `routes/integrations-public.ts`. | The fix is a nonce cookie set at `/connect` and checked at the callback, plus single-use nonces. That needs frontend and proxy cookie handling and a real OAuth click-through to verify. It should be its own PR. |
| MEDIUM, same firm | `GET /api/invitations` returns every pending invite's `token`/`inviteUrl` to all members. A member could accept another invitee's pending invite and set that account's password. | Changing who can see invite links changes the Team page UX, so the founder should decide. Suggested rule: only ADMINs and the inviter see tokens. |
| LOW, same firm | Any member can revoke or resend invites, read the full audit log (`ADMIN_AUDIT` not enforced) and edit firm inputs. Any member can disconnect a colleague's integration. | Role-policy decisions, not isolation bugs. |
| LOW | `POST /api/users` checks for an existing email across all orgs (it can reveal that an email exists somewhere). | Minor; needs a product decision on duplicate emails. |
| Note | `orgMiddleware`'s 30s auth-context cache means a deactivated or demoted user keeps access for up to 30s on a warm lambda. | By design. |

## 4. Files checked and clean

Every route file in `apps/api/src/routes` was checked. Clean means every by-id read and write is scoped by `organizationId`, a `verify*Access` helper, or a binding to an already-verified parent. Highlights of the post-July routes:

- **Companies:** clean.
- **API keys:** session-ADMIN only; revoke is org-filtered.
- **Webhook subscriptions:** ADMIN only, org-filtered, https and non-private URLs.
- **Doc requests:** the request id is bound to the deal and org.
- **Doc-request portal:** the item must belong to the token's request, and the upload is forced to the token's deal and org.
- **Share portal:** data is read by `share.dealId`; downloads check `doc.dealId === share.dealId`.
- **NDA review:** body `documentId` must be on the URL's deal.
- **Legal documents, templates, e-sign:** org-filtered throughout.
- **Deal model:** `DealModel` is filtered by deal and org.
- **Deal reactivations, deal share, deals trash:** org-scoped.
- **HubSpot import:** the job's `organizationId` scopes every lookup and write.
- **Integrations:** list, sync and delete are org-filtered.
- **Outreach:** org-slug gated; stage and contact ids verified.
- **Staged uploads:** `uploads/sign` builds `staging/<orgId>/…` on the server, and `resolveUploadedFile` rejects other orgs' paths and `..`.
- **Deal chat agent tools:** `dealId`/`orgId` are bound in a closure from the verified route; the LLM can't supply them.
- **Managed-agents webhook:** SDK-verified signature.
- **Crons:** secret-gated.
- **API-key auth:** `middleware/auth.ts` derives identity from the key owner, rejects revoked/expired/moved-org keys, and blocks writes for read-only keys.

## 5. Optional founder check (read-only SQL, nothing to migrate)

**No migration is needed for this PR.** If you want to confirm that nobody used one of the holes above before it was closed, run this **read-only** query in the Supabase SQL editor. Every count should be 0.

```sql
SELECT 'deal→foreign company' AS check, count(*) FROM "Deal" d JOIN "Company" c ON c.id = d."companyId" WHERE c."organizationId" <> d."organizationId"
UNION ALL SELECT 'deal→foreign assignee', count(*) FROM "Deal" d JOIN "User" u ON u.id = d."assignedTo" WHERE u."organizationId" <> d."organizationId"
UNION ALL SELECT 'memo→foreign deal', count(*) FROM "Memo" m JOIN "Deal" d ON d.id = m."dealId" WHERE d."organizationId" <> m."organizationId"
UNION ALL SELECT 'document→folder of other deal', count(*) FROM "Document" doc JOIN "Folder" f ON f.id = doc."folderId" WHERE f."dealId" <> doc."dealId"
UNION ALL SELECT 'folder→parent of other deal', count(*) FROM "Folder" f JOIN "Folder" p ON p.id = f."parentId" WHERE p."dealId" <> f."dealId"
UNION ALL SELECT 'notification→foreign deal', count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId" JOIN "Deal" d ON d.id = n."dealId" WHERE d."organizationId" <> u."organizationId";
```

## 6. Test results

- `cd apps/api && npx tsc --noEmit`: clean (exit 0).
- `cd apps/api && npx vitest run`: **301 files passed, 1 skipped; 2796 tests passed, 50 skipped, 0 failed.**
- Baseline `origin/main`: 1 failure, `deal-chat-tools-parity.test.ts`. It hit the 10s timeout under full-suite load, and it passes on re-run and in this branch's run. It is pre-existing and unrelated.
- Every new or extended security test file was run against the `origin/main` versions of the fixed files. Each file's attack cases failed there (14 + 5 failures across the two runs, plus F-17, documents-upload and staff-webhook confirmed red individually). All pass with the fixes; the "same-org still works" cases pass on both.
