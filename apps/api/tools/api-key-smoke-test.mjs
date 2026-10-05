#!/usr/bin/env node
/**
 * Avise API-key smoke test — exercises the public API the way n8n would.
 *
 * Usage (copy the key first, it never appears on screen):
 *   AVISE_API_KEY="$(pbpaste)" node apps/api/tools/api-key-smoke-test.mjs
 *
 * Options:
 *   --base=https://app.avise.io   API host (default production)
 *   --read-only                   skip every write (no records created)
 *   --ai                          also run one AI ingest call (costs AI credit)
 *   --extended                    also exercise the broader endpoint surface:
 *                                 deal shares/doc-requests/team/model/graphs/
 *                                 legal-documents, documents link, folders,
 *                                 contacts connections/interactions/import,
 *                                 activities delete, memos + sections,
 *                                 templates + sections, legal-document
 *                                 templates, watchlist, notifications,
 *                                 conversations, users, audit, deals import
 *                                 analyze. Combine with --ai to also hit the
 *                                 AI-backed corners of that surface (one call
 *                                 each, never looped).
 *
 * Writes create records named "QA-API-TEST …" in the key's organization and
 * delete them again at the end. Endpoints that send email, start e-signatures,
 * change org settings, invite people or are staff-only are deliberately skipped.
 * The key is never printed or written to the report.
 */
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const BASE = String(args.base || 'https://app.avise.io').replace(/\/$/, '');
const KEY = (process.env.AVISE_API_KEY || '').trim();
const READ_ONLY = Boolean(args['read-only']);
const RUN_AI = Boolean(args.ai);
const EXTENDED = Boolean(args.extended);

if (!KEY.startsWith('avise_sk_')) {
  console.error('Set AVISE_API_KEY to an Avise key (avise_sk_…). Example:\n  AVISE_API_KEY="$(pbpaste)" node apps/api/tools/api-key-smoke-test.mjs');
  process.exit(2);
}

const results = [];
const TAG = `QA-API-TEST ${new Date().toISOString().slice(0, 16)}`;

async function call(method, path, { body, form, expect = [200], auth = 'bearer', note = '' } = {}) {
  const headers = {};
  if (auth === 'bearer') headers.Authorization = `Bearer ${KEY}`;
  else if (auth === 'x-api-key') headers['X-API-Key'] = KEY;
  else if (auth === 'bad') headers.Authorization = 'Bearer avise_sk_' + 'A'.repeat(43);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const started = Date.now();
  let status = 0, json = null, text = '';
  try {
    const res = await fetch(BASE + path, { method, headers, body: payload });
    status = res.status;
    text = await res.text();
    try { json = JSON.parse(text); } catch { /* non-JSON (CSV, file) */ }
  } catch (err) {
    text = String(err?.message || err);
  }
  const expected = Array.isArray(expect) ? expect : [expect];
  const pass = expected.includes(status);
  const detail = pass ? '' : (json?.error?.message || json?.message || json?.error || text).toString().slice(0, 160);
  results.push({ method, path, expected: expected.join('/'), status, pass, ms: Date.now() - started, note, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${String(status).padEnd(3)} ${method.padEnd(6)} ${path}${note ? `  (${note})` : ''}${detail ? `  → ${detail}` : ''}`);
  return { status, json, pass };
}

const idOf = (r) => r?.json?.id || r?.json?.data?.id || r?.json?.deal?.id || r?.json?.apiKey?.id;

// ── 1. Authentication ────────────────────────────────────────────────
console.log(`\nAvise API smoke test against ${BASE}${READ_ONLY ? ' (read-only)' : ''}\n`);
await call('GET', '/api/users/me', { auth: 'none', expect: 401, note: 'no key' });
await call('GET', '/api/users/me', { auth: 'bad', expect: 401, note: 'wrong key' });
const me = await call('GET', '/api/users/me', { note: 'Bearer key' });
await call('GET', '/api/users/me', { auth: 'x-api-key', note: 'X-API-Key header' });
if (!me.pass) {
  console.error('\nThe key was rejected, so nothing else can be tested. Check it is copied whole and still Active in Settings → API Keys.');
  process.exit(1);
}
const userId = me.json?.id;
console.log(`\nKey acts as ${me.json?.email} (${me.json?.role}) in "${me.json?.organization?.name}"\n`);

// ── 2. Key management must refuse API keys ───────────────────────────
await call('GET', '/api/api-keys', { expect: 403, note: 'keys cannot list keys' });
await call('POST', '/api/api-keys', { body: { name: 'should-not-exist' }, expect: 403, note: 'keys cannot mint keys' });

// ── 3. Read-only list endpoints ──────────────────────────────────────
const READS = [
  '/api/users/me/team', '/api/users', '/api/organizations/me', '/api/organizations/criteria',
  '/api/organizations/nda-playbook', '/api/deals', '/api/deals/stats/summary', '/api/deals/trash',
  '/api/deals/reactivations', '/api/deals/financial-summaries', '/api/contacts',
  '/api/contacts/insights/duplicates', '/api/contacts/insights/follow-ups', '/api/contacts/insights/network',
  '/api/contacts/insights/scores', '/api/contacts/insights/stale', '/api/contacts/insights/timeline',
  '/api/contacts/export', '/api/companies', '/api/tasks', '/api/activities/recent', '/api/data-rooms/summary',
  '/api/documents/alerts', '/api/memos', '/api/legal-documents', '/api/legal-document-templates',
  '/api/conversations', '/api/ai/status', '/api/ai/email-templates', `/api/notifications?userId=${userId}`,
  '/api/invitations', '/api/firm-context', '/api/firm-teaser', '/api/onboarding/status',
  '/api/templates', '/api/watchlist', '/api/graphs', '/api/integrations',
  '/api/audit', '/api/audit/summary', '/api/audit/export.csv', '/api/export/deals', '/api/export/deals?format=csv',
  '/api/usage/me', '/api/ingest/pending-review',
  '/api/deals?updatedSince=2026-01-01&limit=5', '/api/deals?limit=2&offset=1', '/api/contacts?updatedSince=2026-01-01',
  '/api/companies?limit=5', '/api/tasks?updatedSince=2026-01-01', '/api/webhook-subscriptions/events',
  '/api/webhook-subscriptions',
];
for (const path of READS) await call('GET', path);

// ── 4. Full write lifecycle (cleaned up at the end) ──────────────────
const cleanup = [];
if (!READ_ONLY) {
  const company = await call('POST', '/api/companies', { body: { name: `${TAG} Co`, industry: 'Software' }, expect: 201 });
  const companyId = idOf(company);
  if (companyId) {
    await call('GET', `/api/companies/${companyId}`);
    await call('PATCH', `/api/companies/${companyId}`, { body: { description: 'smoke test' } });
  }

  await call('POST', '/api/deals', { body: { industry: 'Software' }, expect: 400, note: 'missing name' });
  const deal = await call('POST', '/api/deals', {
    body: { name: `${TAG} Deal`, companyName: `${TAG} Target`, industry: 'Software', revenue: 12.5, ebitda: 2.1, priority: 'HIGH', source: 'api-smoke-test', tags: ['qa'] },
    expect: 201,
  });
  const dealId = idOf(deal);
  if (dealId) {
    cleanup.push(['DELETE', `/api/deals/${dealId}`, [204, 404]]);
    await call('GET', `/api/deals/${dealId}`);
    await call('PATCH', `/api/deals/${dealId}`, { body: { stage: 'DUE_DILIGENCE', stageNote: 'smoke test' } });
    await call('GET', `/api/deals/00000000-0000-0000-0000-000000000000`, { expect: 404, note: 'unknown deal' });

    const note = await call('POST', `/api/deals/${dealId}/activities`, { body: { type: 'NOTE_ADDED', title: `${TAG} note`, description: 'from API' }, expect: 201 });
    const noteId = idOf(note);
    await call('GET', `/api/deals/${dealId}/activities`);
    if (noteId) await call('GET', `/api/activities/${noteId}`);

    for (const sub of ['documents', 'folders', 'financials', 'financials/summary', 'financials/timeseries',
      'financials/validation', 'financials/conflicts', 'shares', 'doc-requests', 'doc-requests/templates',
      'legal-documents', 'nda-reviews', 'model', 'model/cases', 'graphs', 'access-timeline', 'chat/history', 'ai-cache']) {
      await call('GET', `/api/deals/${dealId}/${sub}`);
    }
    await call('GET', `/api/integrations/activities?dealId=${dealId}`);
    await call('GET', `/api/deals/${dealId}/team`);
    await call('GET', `/api/deals/${dealId}/teasers`);
    await call('GET', `/api/memos?dealId=${dealId}`);

    const folder = await call('POST', `/api/deals/${dealId}/folders`, { body: { name: `${TAG} folder` }, expect: 201 });
    const folderId = idOf(folder);
    if (folderId) { await call('GET', `/api/folders/${folderId}`); await call('GET', `/api/folders/${folderId}/documents`); }

    // Upload a tiny real PDF.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'qa-api-test.pdf');
    form.append('name', `${TAG} doc.pdf`);
    form.append('type', 'OTHER');
    const doc = await call('POST', `/api/deals/${dealId}/documents`, { form, expect: [200, 201] });
    const docId = idOf(doc);
    if (docId) {
      await call('GET', `/api/documents/${docId}`);
      await call('GET', `/api/documents/${docId}/download`, { expect: [200, 302] });
      await call('PATCH', `/api/documents/${docId}`, { body: { name: `${TAG} renamed.pdf` } });
      await call('DELETE', `/api/documents/${docId}`, { expect: [200, 204] });
    }
    const big = new FormData();
    big.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024, 0x20)], { type: 'application/pdf' }), 'too-big.pdf');
    await call('POST', `/api/deals/${dealId}/documents`, { form: big, expect: 413, note: '5 MB body is over the 4.5 MB limit' });
    await call('POST', '/api/uploads/sign', { body: { fileName: 'big.pdf', contentType: 'application/pdf', size: 6_000_000, purpose: 'data-room', dealId } });

    const task = await call('POST', '/api/tasks', { body: { title: `${TAG} task`, dealId, priority: 'HIGH' }, expect: 201 });
    const taskId = idOf(task);
    if (taskId) {
      await call('GET', `/api/tasks?dealId=${dealId}`);
      await call('GET', `/api/tasks/${taskId}`);
      await call('PATCH', `/api/tasks/${taskId}`, { body: { status: 'COMPLETED' } });
      await call('DELETE', `/api/tasks/${taskId}`, { expect: [200, 204] });
    }

    const email = `qa.api.test.${Date.now()}@example.com`;
    const contact = await call('POST', '/api/contacts', { body: { firstName: 'QA', lastName: 'API Test', email, company: `${TAG} Target`, type: 'BANKER' }, expect: 201 });
    const contactId = idOf(contact);
    await call('POST', '/api/contacts', { body: { firstName: 'QA', lastName: 'Dup', email }, expect: 409, note: 'duplicate email' });
    await call('PATCH', '/api/contacts/00000000-0000-0000-0000-000000000000', { body: { title: 'x' }, expect: 404, note: 'unknown contact' });
    if (contactId) {
      await call('GET', `/api/contacts/${contactId}`);
      await call('PATCH', `/api/contacts/${contactId}`, { body: { title: 'Managing Director' } });
      await call('POST', `/api/contacts/${contactId}/deals`, { body: { dealId }, expect: [200, 201] });
      await call('DELETE', `/api/contacts/${contactId}`, { expect: [200, 204] });
    }

    await call('DELETE', `/api/deals/${dealId}`, { expect: 204 });
    await call('POST', `/api/deals/${dealId}/restore`, { expect: [200, 204] });
  }

  // Webhook subscription lifecycle (https://example.com never answers 2xx to POST; the test call just has to report it).
  const hook = await call('POST', '/api/webhook-subscriptions', { body: { url: 'https://example.com/avise-smoke-test', events: ['deal.created'] }, expect: 201 });
  const hookId = hook.json?.webhook?.id;
  await call('POST', '/api/webhook-subscriptions', { body: { url: 'http://example.com/x', events: ['deal.created'] }, expect: 400, note: 'http refused' });
  if (hookId) {
    await call('POST', `/api/webhook-subscriptions/${hookId}/test`, { note: 'ping delivery reported' });
    await call('PATCH', `/api/webhook-subscriptions/${hookId}`, { body: { active: false } });
    await call('DELETE', `/api/webhook-subscriptions/${hookId}`, { expect: 204 });
  }

  if (RUN_AI) {
    const ing = await call('POST', '/api/ingest/text', {
      body: { text: `${TAG}. Acme Analytics is a B2B SaaS company with revenue of $18M and EBITDA of $3.2M in FY2025, growing 35% year on year. The founders are exploring a majority sale.`, sourceType: 'note', sourceName: TAG },
      expect: [200, 201, 503], note: '503 = AI provider unavailable',
    });
    const ingDeal = ing.json?.deal?.id;
    if (ingDeal) cleanup.push(['DELETE', `/api/deals/${ingDeal}`, [204, 404]]);
  }

  for (const [m, p, e] of cleanup) await call(m, p, { expect: e, note: 'cleanup' });
  if (companyId) await call('DELETE', `/api/companies/${companyId}`, { expect: [200, 204, 409], note: 'cleanup' });
}

// ── 5. Extended coverage phase (--extended) ───────────────────────────
// A second, independent write lifecycle covering endpoints the core phase
// above doesn't touch. Its own TAG fixtures (deal/contacts/folder/document),
// its own cleanup list, run in a try/finally so a failure partway through
// still cleans up everything created so far. Every endpoint here was read
// from its route handler + zod schema (see PR description) to pick the
// right body shape and expected status codes.
if (EXTENDED && !READ_ONLY) {
  console.log(`\n── Extended coverage phase (--extended${RUN_AI ? ' + ai' : ''}) ──\n`);
  const extCleanup = []; // [method, path, expectArray, note] — run in reverse in `finally`
  const pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const newPdfForm = (name) => {
    const f = new FormData();
    f.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), name);
    f.append('name', name);
    f.append('type', 'OTHER');
    return f;
  };

  try {
    // ── Fixtures ───────────────────────────────────────────────────
    const extDeal = await call('POST', '/api/deals', {
      body: { name: `${TAG} Ext Deal`, companyName: `${TAG} Ext Target`, industry: 'Software', priority: 'MEDIUM', source: 'api-smoke-test-extended' },
      expect: 201, note: 'ext fixture',
    });
    const extDealId = idOf(extDeal);
    if (!extDealId) {
      console.error('Extended phase: could not create the fixture deal, skipping the rest of --extended.');
    } else {
      extCleanup.push(['DELETE', `/api/deals/${extDealId}`, [204, 404], 'ext cleanup: deal']);

      const extFolder = await call('POST', `/api/deals/${extDealId}/folders`, { body: { name: `${TAG} ext folder` }, expect: 201, note: 'ext fixture' });
      const extFolderId = idOf(extFolder);
      if (extFolderId) extCleanup.push(['DELETE', `/api/folders/${extFolderId}`, [200, 204], 'ext cleanup: folder']);

      const extDoc = await call('POST', `/api/deals/${extDealId}/documents`, { form: newPdfForm('qa-ext-test.pdf'), expect: [200, 201], note: 'ext fixture' });
      const extDocId = idOf(extDoc);
      if (extDocId) extCleanup.push(['DELETE', `/api/documents/${extDocId}`, [200, 204, 404], 'ext cleanup: document']);

      const emailA = `qa.ext.test.a.${Date.now()}@example.com`;
      const emailB = `qa.ext.test.b.${Date.now()}@example.com`;
      const contactA = await call('POST', '/api/contacts', { body: { firstName: 'QA', lastName: `${TAG} Ext A`, email: emailA, type: 'BANKER' }, expect: 201, note: 'ext fixture' });
      const contactB = await call('POST', '/api/contacts', { body: { firstName: 'QA', lastName: `${TAG} Ext B`, email: emailB, type: 'ADVISOR' }, expect: 201, note: 'ext fixture' });
      const contactAId = idOf(contactA);
      const contactBId = idOf(contactB);
      if (contactAId) extCleanup.push(['DELETE', `/api/contacts/${contactAId}`, [200, 204], 'ext cleanup: contact A']);
      if (contactBId) extCleanup.push(['DELETE', `/api/contacts/${contactBId}`, [200, 204], 'ext cleanup: contact B']);

      // ── A. Deal shares (no invitedEmail — never emails anyone) ─────
      const share = await call('POST', `/api/deals/${extDealId}/shares`, { body: { label: `${TAG} share` }, expect: 201 });
      const shareId = share.json?.share?.id;
      await call('GET', `/api/deals/${extDealId}/shares`);
      if (shareId) await call('DELETE', `/api/deals/${extDealId}/shares/${shareId}`, { expect: 200 });

      // ── A. Doc requests (no recipientEmail — never emails anyone) ──
      await call('GET', `/api/deals/${extDealId}/doc-requests/templates`);
      const docReq = await call('POST', `/api/deals/${extDealId}/doc-requests`, {
        body: { items: [{ label: `${TAG} doc item`, required: true }], message: 'please send' }, expect: 201,
      });
      const docReqId = docReq.json?.request?.id;
      await call('GET', `/api/deals/${extDealId}/doc-requests`);
      if (docReqId) {
        await call('PATCH', `/api/deals/${extDealId}/doc-requests/${docReqId}`, { body: { message: 'updated message' }, expect: 200 });
        await call('DELETE', `/api/deals/${extDealId}/doc-requests/${docReqId}`, { expect: 200 });
      }

      // ── A. document-requests (emails deal-team members OTHER than the
      // caller; the fixture deal has no other team members, so this is a
      // no-recipient no-op — confirmed by reading documents-sharing.ts). ──
      await call('POST', `/api/deals/${extDealId}/document-requests`, { body: { documentName: `${TAG} missing doc` }, expect: [200, 201] });

      // ── A. Team: add self, patch role, remove self (self-notification
      // only — never another real user). ──
      const member = await call('POST', `/api/deals/${extDealId}/team`, { body: { userId, role: 'MEMBER' }, expect: [200, 201] });
      const memberId = idOf(member);
      await call('GET', `/api/deals/${extDealId}/team`);
      if (memberId) {
        await call('PATCH', `/api/deals/${extDealId}/team/${memberId}`, { body: { role: 'VIEWER' }, expect: 200 });
        await call('DELETE', `/api/deals/${extDealId}/team/${memberId}`, { expect: 204 });
      }

      // ── A. Teasers (GET only — POST calls the firm-teaser generation
      // agent and also needs a pre-existing profile; AI-gated + skipped,
      // see "Not tested" below). ──
      await call('GET', `/api/deals/${extDealId}/teasers`);

      // ── A. Model: GET both shapes, then PUT the SAME Base assumptions
      // back (no-op write) and try the export (expects 400 NO_FINANCIALS
      // on a deal with no extracted financials — still a valid contract
      // check). ──
      const model = await call('GET', `/api/deals/${extDealId}/model`);
      await call('GET', `/api/deals/${extDealId}/model/cases`);
      if (model.json?.assumptions) {
        await call('PUT', `/api/deals/${extDealId}/model`, { body: model.json.assumptions, expect: 200, note: 'no-op: same assumptions' });
      }
      await call('POST', `/api/deals/${extDealId}/model/export`, { expect: [200, 400], note: '400 = NO_FINANCIALS on an empty deal' });

      // ── A. Financials reads not already covered by the base READS loop ──
      for (const sub of ['financials/analysis', 'financials/insights', 'financials/cross-doc', 'financials/benchmark', 'financials/memo']) {
        await call('GET', `/api/deals/${extDealId}/${sub}`);
      }
      if (extDocId) await call('DELETE', `/api/deals/${extDealId}/financials/by-document/${extDocId}`, { expect: [200, 204, 404] });

      // ── A. Reconcile / extraction-debug (read-only diagnostics) ─────
      await call('GET', `/api/deals/${extDealId}/reconcile`);
      await call('GET', `/api/deals/${extDealId}/extraction-debug`);

      // ── A. ai-cache DELETE + chat/history DELETE (GETs are in the base
      // READS sub-list already) ──
      await call('DELETE', `/api/deals/${extDealId}/ai-cache`, { expect: [200, 204] });
      await call('DELETE', `/api/deals/${extDealId}/chat/history`, { expect: [200, 204] });

      // ── A. Graphs ────────────────────────────────────────────────────
      const graph = await call('POST', `/api/deals/${extDealId}/graphs`, {
        body: { title: `${TAG} graph`, chartType: 'bar', series: [] }, expect: [201, 503], note: '503 = CustomGraph migration not applied',
      });
      const graphId = idOf(graph);
      if (graphId) {
        await call('PATCH', `/api/graphs/${graphId}`, { body: { title: `${TAG} graph renamed` }, expect: 200 });
        await call('DELETE', `/api/graphs/${graphId}`, { expect: 204 });
      }

      // ── A. Legal documents — create our own verified template first
      // (POST sets verifiedAt automatically, no admin step needed), then
      // a draft off it. Never call send / request-signature / send-for-
      // signature / check-signatures-that-could-trigger-anything — only
      // check-signatures (pure poll, no outbound) is included. ──
      const legalTemplate = await call('POST', '/api/legal-document-templates', {
        body: { name: `${TAG} NDA template`, docType: 'NDA', bodyHtml: '<p>Template for {{COUNTERPARTY_NAME}}</p>' }, expect: 201,
      });
      const legalTemplateId = idOf(legalTemplate);
      if (legalTemplateId) {
        await call('PATCH', `/api/legal-document-templates/${legalTemplateId}`, { body: { name: `${TAG} NDA template v2` }, expect: 200 });

        const legalDoc = await call('POST', `/api/deals/${extDealId}/legal-documents`, {
          body: { templateId: legalTemplateId, title: `${TAG} NDA draft`, counterpartyName: `${TAG} Counterparty` }, expect: 201,
        });
        const legalDocId = idOf(legalDoc);
        if (legalDocId) {
          await call('GET', `/api/deals/${extDealId}/legal-documents`);
          await call('PATCH', `/api/legal-documents/${legalDocId}`, { body: { title: `${TAG} NDA draft v2` }, expect: 200 });
          await call('GET', `/api/legal-documents/${legalDocId}/export?format=docx`, { expect: [200, 409], note: 'depends on Google Drive export working in prod' });
          await call('DELETE', `/api/legal-documents/${legalDocId}`, { expect: 204 });
        }
        await call('DELETE', `/api/legal-document-templates/${legalTemplateId}`, { expect: [200, 204] });
      }
      // Pure read/poll — no outbound signature request is sent, it only
      // checks Google Drive for already-signed documents (see
      // docs/nda-signature-detection-setup.md — this is the on-demand
      // path CLAUDE.md says is the ACTIVE one outside prod).
      await call('POST', '/api/legal-documents/check-signatures', { expect: 200 });

      // ── B. Documents: link (self-copy into the same deal, confirmed
      // safe — only in-app notifications, no email) ──
      if (extDocId) {
        const linked = await call('POST', `/api/documents/${extDocId}/link`, { body: { targetDealId: extDealId }, expect: 201 });
        const linkedId = idOf(linked);
        if (linkedId) await call('DELETE', `/api/documents/${linkedId}`, { expect: [200, 204] });
      }

      // ── B. Folders: insights GET (404 until one exists) / POST
      // (manual, non-AI upsert) / PATCH rename ──
      if (extFolderId) {
        await call('GET', `/api/folders/${extFolderId}/insights`, { expect: 404 });
        await call('POST', `/api/folders/${extFolderId}/insights`, { body: { summary: 'manual test summary', completionPercent: 10 }, expect: 201 });
        await call('PATCH', `/api/folders/${extFolderId}`, { body: { name: `${TAG} ext folder renamed` }, expect: 200 });
      }

      // ── C. Contacts: connections, interactions, deal link/unlink ───
      if (contactAId && contactBId) {
        const conn = await call('POST', `/api/contacts/${contactAId}/connections`, { body: { relatedContactId: contactBId, type: 'KNOWS' }, expect: 201 });
        const connId = idOf(conn);
        await call('GET', `/api/contacts/${contactAId}/connections`);
        if (connId) await call('DELETE', `/api/contacts/${contactAId}/connections/${connId}`, { expect: 200 });

        await call('POST', `/api/contacts/${contactAId}/interactions`, { body: { type: 'NOTE', title: `${TAG} interaction` }, expect: 201 });

        await call('POST', `/api/contacts/${contactAId}/deals`, { body: { dealId: extDealId, role: 'ADVISOR' }, expect: [200, 201] });
        await call('DELETE', `/api/contacts/${contactAId}/deals/${extDealId}`, { expect: 200 });
      }

      // ── C. Contacts import (2 fixture contacts, deleted via the
      // search they're found under — /import doesn't echo back ids) ──
      const importEmailA = `qa.ext.import.a.${Date.now()}@example.com`;
      const importEmailB = `qa.ext.import.b.${Date.now()}@example.com`;
      await call('POST', '/api/contacts/import', {
        body: { contacts: [
          { firstName: 'QA', lastName: `${TAG} Import A`, email: importEmailA, type: 'OTHER' },
          { firstName: 'QA', lastName: `${TAG} Import B`, email: importEmailB, type: 'OTHER' },
        ] },
        expect: 201,
      });
      const importedList = await call('GET', `/api/contacts?search=${encodeURIComponent(TAG)} Import`);
      for (const c of (importedList.json?.contacts || importedList.json || [])) {
        if (typeof c?.id === 'string' && typeof c?.lastName === 'string' && c.lastName.includes(`${TAG} Import`)) {
          await call('DELETE', `/api/contacts/${c.id}`, { expect: [200, 204], note: 'cleanup: imported contact' });
        }
      }

      // ── D. Activities: delete a note created in this phase ─────────
      const extNote = await call('POST', `/api/deals/${extDealId}/activities`, { body: { type: 'NOTE_ADDED', title: `${TAG} ext note` }, expect: 201 });
      const extNoteId = idOf(extNote);
      if (extNoteId) await call('DELETE', `/api/activities/${extNoteId}`, { expect: [200, 204] });

      // ── E. Memos: create (autoGenerate:false — no AI call), sections
      // CRUD + reorder + apply, conversations, delete ──
      const memo = await call('POST', '/api/memos', { body: { title: `${TAG} memo`, dealId: extDealId, autoGenerate: false }, expect: 201 });
      const memoId = idOf(memo);
      if (memoId) {
        await call('GET', `/api/memos/${memoId}`);
        await call('PATCH', `/api/memos/${memoId}`, { body: { title: `${TAG} memo v2` }, expect: 200 });
        const section = await call('POST', `/api/memos/${memoId}/sections`, { body: { type: 'EXECUTIVE_SUMMARY', title: 'Summary', content: 'draft' }, expect: 201 });
        const sectionId = idOf(section);
        await call('GET', `/api/memos/${memoId}/sections`);
        if (sectionId) {
          await call('PATCH', `/api/memos/${memoId}/sections/${sectionId}`, { body: { content: 'updated draft' }, expect: 200 });
          await call('POST', `/api/memos/${memoId}/sections/reorder`, { body: { sections: [{ id: sectionId, sortOrder: 0 }] }, expect: 200 });
          await call('POST', `/api/memos/${memoId}/sections/${sectionId}/apply`, { body: { content: 'applied content', insertPosition: 'replace' }, expect: 200 });
          await call('DELETE', `/api/memos/${memoId}/sections/${sectionId}`, { expect: 200 });
        }
        await call('GET', `/api/memos/${memoId}/conversations`);
        await call('DELETE', `/api/memos/${memoId}`, { expect: [200, 204] });
      }

      // ── F. Templates: create, CRUD, sections, duplicate (+ delete
      // the duplicate), use, delete ──
      const template = await call('POST', '/api/templates', { body: { name: `${TAG} template`, category: 'INVESTMENT_MEMO' }, expect: 201 });
      const templateId = idOf(template);
      if (templateId) {
        await call('GET', `/api/templates/${templateId}`);
        await call('PATCH', `/api/templates/${templateId}`, { body: { description: 'updated' }, expect: 200 });
        const tplSection = await call('POST', `/api/templates/${templateId}/sections`, { body: { title: 'Market' }, expect: 201 });
        const tplSectionId = idOf(tplSection);
        await call('GET', `/api/templates/${templateId}/sections`);
        if (tplSectionId) {
          await call('PATCH', `/api/templates/${templateId}/sections/${tplSectionId}`, { body: { title: 'Market v2' }, expect: 200 });
          await call('POST', `/api/templates/${templateId}/sections/reorder`, { body: { sections: [{ id: tplSectionId, sortOrder: 1 }] }, expect: 200 });
          await call('DELETE', `/api/templates/${templateId}/sections/${tplSectionId}`, { expect: 200 });
        }
        const dup = await call('POST', `/api/templates/${templateId}/duplicate`, { body: { name: `${TAG} template copy` }, expect: 201 });
        const dupId = idOf(dup);
        if (dupId) await call('DELETE', `/api/templates/${dupId}`, { expect: 200 });
        await call('POST', `/api/templates/${templateId}/use`, { expect: 200 });
        await call('DELETE', `/api/templates/${templateId}`, { expect: 200 });
      }

      // ── H. Watchlist ──────────────────────────────────────────────
      const watch = await call('POST', '/api/watchlist', { body: { companyName: `${TAG} Watch Co` }, expect: 201 });
      const watchId = idOf(watch);
      await call('GET', '/api/watchlist');
      if (watchId) await call('DELETE', `/api/watchlist/${watchId}`, { expect: [200, 204] });

      // ── I. Notifications: self-targeted only (userId from /users/me) ──
      const notif = await call('POST', '/api/notifications', {
        body: { userId, type: 'SYSTEM', title: `${TAG} notification` }, expect: [201, 202],
      });
      const notifId = idOf(notif);
      if (notifId) {
        await call('GET', `/api/notifications/${notifId}`);
        await call('PATCH', `/api/notifications/${notifId}`, { body: { isRead: true }, expect: 200 });
        await call('DELETE', `/api/notifications/${notifId}`, { expect: [200, 204] });
      }

      // ── J. Conversations (non-AI parts). POST /messages is AI — only
      // run under --ai, once, never looped. ──
      const convo = await call('POST', '/api/conversations', { body: { dealId: extDealId, userId }, expect: 201 });
      const convoId = idOf(convo);
      if (convoId) {
        await call('GET', `/api/conversations/${convoId}`);
        await call('GET', `/api/conversations/${convoId}/messages`);
        if (RUN_AI) {
          await call('POST', `/api/conversations/${convoId}/messages`, {
            body: { content: 'What is this deal about?', userId }, expect: [200, 201, 503],
            note: '503 = AI provider unavailable',
          });
        }
        await call('DELETE', `/api/conversations/${convoId}`, { expect: 204 });
      }

      // ── K. Users: self-reads ─────────────────────────────────────
      await call('GET', `/api/users/${userId}`);
      await call('GET', `/api/users/${userId}/deals`);
      await call('GET', `/api/users/${userId}/notifications`);

      // ── L. Audit trail for the fixture deal ─────────────────────
      await call('GET', `/api/audit/entity/${extDealId}`);

      // ── M. Deals import analyze (non-AI CSV/paste parser — confirmed
      // by reading dealImportMapper.ts, no LLM import there) ──
      await call('POST', '/api/deals/import/analyze', {
        body: { source: 'paste', rawData: `Company\tDeal Name\n${TAG} Import Co\t${TAG} Import Deal` }, expect: 200,
      });

      // ── Settings no-ops (rule: GET then PUT back the SAME value) ───
      const firmContext = await call('GET', '/api/firm-context');
      void firmContext; // PUT skipped: writing org settings back risks wiping them if the shape is misread
      const firmTeaser = await call('GET', '/api/firm-teaser');
      void firmTeaser;

      // ── AI-gated corners of this same surface (--ai; one call each,
      // never looped) ──
      if (RUN_AI) {
        // NDA review: upload the same tiny fixture PDF, expect a real
        // review or a clean provider-unavailable response.
        await call('POST', `/api/deals/${extDealId}/nda-reviews`, {
          form: newPdfForm('qa-ext-nda.pdf'), expect: [200, 201, 400, 422, 503], note: '503 = AI provider unavailable, 422 = model declined',
        });
        // financials/insights/regenerate on a deal with no financials —
        // exercises the AI path's empty-input handling.
        await call('POST', `/api/deals/${extDealId}/financials/insights/regenerate`, { expect: [200, 503], note: '503 = AI provider unavailable' });
      }
    }
  } finally {
    for (const [m, p, e, note] of extCleanup.reverse()) {
      await call(m, p, { expect: e, note: note || 'ext cleanup' });
    }
  }
}

// ── Not tested, with reasons ───────────────────────────────────────────
// Every mounted (app-lite.ts / app-ai.ts), authMiddleware-gated route this
// script — base + --extended — does not call, and why. Derived by reading
// every router.{get,post,patch,put,delete} in apps/api/src/routes and
// following router.use() sub-mounts, same way the mounts are wired up.
const NOT_TESTED = [
  // ── Unsafe by the rules this script runs under: email / SMS / signature /
  // outreach / invitations ───────────────────────────────────────────────
  ['POST', '/api/deals/:dealId/doc-requests/:id/remind', 'emails the recipient — manual reminder send'],
  ['POST', '/api/legal-documents/:id/send', 'Gmail-sends the document to a real recipient'],
  ['POST', '/api/legal-documents/:id/request-signature', 'starts an external eSignature flow'],
  ['POST', '/api/legal-documents/:id/send-for-signature', 'starts an external eSignature flow (legal-doc-esign.ts)'],
  ['POST', '/api/deals/:dealId/legal-documents/upload', 'skipped for simplicity — import path for externally-signed NDAs, not a generation path'],
  ['POST', '/api/deals/:dealId/legal-documents/import-gdoc', 'imports a real Google Doc the key holder would have to supply'],
  ['GET', '/api/invitations', 'already read in base READS; POST/bulk/resend/DELETE below are the unsafe part'],
  ['POST', '/api/invitations', 'invites a real person by email'],
  ['POST', '/api/invitations/bulk', 'invites multiple real people by email'],
  ['POST', '/api/invitations/:id/resend', 'resends an invitation email'],
  ['DELETE', '/api/invitations/:id', 'would revoke a pre-existing invitation — this script only touches records it creates, and never creates invitations'],
  ['POST', '/api/deals/:id/teasers', 'AI-generated firm teaser — also needs a pre-existing firm-teaser profile this script cannot safely create/guess; AI-gating alone would not make a profile appear'],
  ['POST', '/api/outreach/*', 'outreach.ts / outreach-replyio.ts / outreach-import.ts / outreach-settings.ts — single-org (requireCiceroCapital gate) and every write there risks a real Reply.io/email send'],
  ['POST', '/api/contacts/:id/email-summary (ai)', 'contacts-insights.ts GET /:id/email-summary calls Gmail for the contact’s real inbox thread'],
  ['GET', '/api/contacts/insights/gmail-suggestions', 'reads the key holder’s real Gmail via the Gmail integration'],
  ['POST', '/api/notifications/generate-follow-up-reminders', 'bulk-creates reminder notifications for every user in the org, not just the caller'],
  ['POST', '/api/notifications/mark-all-read', 'would flip real unread state for the caller’s actual notifications, not a fixture this script created'],
  ['DELETE', '/api/notifications', 'bulk-delete, not scoped to fixtures this script created'],
  ['PUT', '/api/firm-context', 'org setting — a write-back could wipe the real firm context'],
  ['PUT', '/api/firm-teaser', 'org setting — a write-back could wipe real teaser profiles'],
  ['POST', '/api/documents/:id/analyze', 'AI document analysis — listed as AI-gated but needs a document with real extractable content; the tiny fixture PDF has none worth analyzing and this script keeps AI calls to one-shot, pre-identified cases'],
  ['POST', '/api/deals/:id/analyze', 'AI deal analysis (deals-analysis.ts) — same reasoning as documents/:id/analyze'],
  ['POST', '/api/deals/:id/follow-up-questions', 'AI — not in the requested COVER list, skipped to bound scope'],
  ['POST', '/api/deals/:dealId/generate-thesis', 'AI, multi-call LangGraph — expensive and not in the requested COVER list'],
  ['POST', '/api/deals/:dealId/analyze-risks', 'AI, multi-call LangGraph — expensive and not in the requested COVER list'],
  ['POST', '/api/deals/:dealId/scorecard', 'AI — not in the requested COVER list'],
  ['POST', '/api/deals/:dealId/rescore', 'AI scorecard re-run — not in the requested COVER list'],
  ['POST', '/api/deals/:dealId/financials/extract', 'AI extraction — needs a real financial document; the fixture PDF has no financial content'],
  ['POST', '/api/documents/:documentId/extract-financials', 'AI extraction — same reasoning'],
  ['POST', '/api/deals/:dealId/financials/resolve', 'needs a real FinancialStatement conflict to resolve; none exists on a fresh fixture deal'],
  ['POST', '/api/deals/:dealId/financials/resolve-all', 'same — needs a real conflict'],
  ['POST', '/api/folders/:id/generate-insights', 'AI — not in the requested COVER list (manual POST /insights is covered instead)'],
  ['POST', '/api/memos/:id/sections/:sectionId/generate', 'AI section generation — not in the requested COVER list'],
  ['POST', '/api/memos/:id/chat', 'AI memo chat — not in the requested COVER list'],
  ['POST', '/api/memos/:id/generate-all', 'AI — generates every section of a memo, expensive, not in the requested COVER list'],
  ['POST', '/api/memos/suggest-meta', 'AI — not in the requested COVER list'],
  ['POST', '/api/firm-context/generate', 'AI — not in the requested COVER list (GET + no-op PUT are covered instead)'],
  ['POST', '/api/firm-teaser/generate-prompt', 'AI — not in the requested COVER list'],
  ['POST', '/api/firm-teaser/extract-context', 'non-AI but needs a real document upload to extract meaningful text from; low value against a 46-byte fixture PDF, skipped to bound scope'],
  ['POST', '/api/ai/*', 'ai.ts / ai-agents.ts / ai-portfolio.ts — chat, enrich-contact, suggest-follow-up, meeting-prep, scan-signals, scan-inbox(/stream), draft-email — broad AI surface, none named in the requested COVER list'],
  ['POST', '/api/ingest/*', 'ingest.ts / ingest-text.ts / ingest-upload.ts / ingest-drive.ts / ingest-url.ts — covered once via /api/ingest/text under --ai in the base phase; the rest (drive, upload, url) need real external sources'],
  ['POST', '/api/onboarding/enrich-firm', 'AI firm research agent — not in the requested COVER list'],
  ['POST', '/api/onboarding/create-demo-deal', 'creates a demo deal with seeded AI content outside this script’s TAG-fixture pattern'],
  ['POST', '/api/portfolio/chat', 'AI — not in the requested COVER list'],
  ['POST', '/api/conversations/:id/messages (portfolio)', 'same endpoint covered once under --ai for the deal-scoped conversation fixture'],
  ['POST', '/api/hubspot/*', 'hubspot-import.ts — connect/import mutate a real external HubSpot account'],
  ['POST', '/api/integrations/:provider/connect', 'connects a real external account'],
  ['POST', '/api/integrations/:provider/api-key', 'stores a real external API key'],
  ['POST', '/api/integrations/:id/sync', 'triggers a real sync against a connected external account'],
  ['DELETE', '/api/integrations/:id', 'would disconnect a real pre-existing integration'],

  // ── Org-level settings this script never writes (no safe no-op pattern
  // applies, or not requested) ───────────────────────────────────────────
  ['PATCH', '/api/organizations/me', 'org-wide settings — no-op write not attempted this pass; not in the requested COVER list'],
  ['PATCH', '/api/organizations/criteria', 'org-wide investment criteria — same reasoning'],
  ['PATCH', '/api/organizations/nda-playbook', 'org-wide NDA playbook — same reasoning'],
  ['PATCH', '/api/users/me', 'the caller’s own profile — a PATCH could still race a real session editing it; not in the requested COVER list'],
  ['POST', '/api/users/me/avatar', 'would overwrite the caller’s real avatar'],
  ['PATCH', '/api/organizations/me/staff-access-webhook', 'org-wide staff-access webhook secret'],

  // ── Staff-only / internal / admin / security (explicitly excluded) ─────
  ['*', '/api/internal/*', 'Pocket Fund staff-only, cross-org by design — explicitly excluded'],
  ['POST', '/api/admin/security/run-isolation-test', 'explicitly excluded (writes)'],
  ['GET', '/api/admin/security/dashboard', 'admin-only; not requested'],
  ['*', '/api/account/security/*', 'explicitly excluded'],
  ['DELETE', '/api/auth/sessions/:id', 'explicitly excluded — would kill a real session'],
  ['GET', '/api/auth/sessions', 'reads real session list; low value, skipped alongside the DELETE it pairs with'],
  ['GET', '/api/auth/workspace-email', 'reads live Workspace-email OAuth status; not requested'],
  ['POST', '/api/users', 'creates another real user (USER_CREATE) — explicitly excluded (users POST/DELETE/PATCH :id other users)'],
  ['PATCH', '/api/users/:id', 'edits another real user — explicitly excluded'],
  ['DELETE', '/api/users/:id', 'deletes another real user — explicitly excluded'],

  // ── Webhooks / OAuth callbacks / cron — public or shared-secret auth, not
  // the API-key auth this script exercises ───────────────────────────────
  ['POST', '/api/webhooks/dropbox-sign', 'public webhook, HMAC-verified — not API-key auth'],
  ['POST', '/api/webhooks/reply-io/:secret', 'public webhook, shared-secret — not API-key auth'],
  ['POST', '/api/webhooks/clay-import/:secret', 'public webhook, shared-secret — not API-key auth'],
  ['POST', '/api/webhooks/clay-enrichment/:secret', 'public webhook, shared-secret — not API-key auth'],
  ['POST', '/api/webhooks/managed-agents', 'public webhook, HMAC-verified — not API-key auth'],
  ['POST', '/api/integrations/webhooks/:provider', 'public provider webhook — not API-key auth'],
  ['GET', '/api/integrations/oauth/:provider/callback', 'public OAuth callback, signed-state auth — not API-key auth'],
  ['POST', '/api/integrations/_cron/sync-all', 'CRON_SECRET auth, not API-key auth'],
  ['POST', '/api/cron/*', 'signal-scan, doc-request-reminders, reactivation, weekly-digest, share-expiry-warnings, reengagement-nudge, usage-reconciliation — CRON_SECRET auth, not API-key auth, and several send real emails'],
  ['GET/POST', '/api/public/*', 'portal.ts / doc-request-portal.ts / invitations-accept.ts / welcome-email.ts — public, token-authenticated, no API key involved'],
  ['POST', '/api/webhooks/legal-docs', 'disabled in this environment (see CLAUDE.md — Drive push signature detection is off outside the verified prod domain)'],

  // ── Narrow or low-value reads, intentionally left out to bound scope ───
  ['GET', '/api/users/me/avatar / /api/memos/debug', 'debug/avatar endpoints, no business-logic value for this audit'],
  ['GET', '/api/documents/:id/download', 'already exercised in the base phase on the base-phase document'],
  ['GET', '/api/deals/:id (various query variants)', 'covered once in the base phase; the extended phase reuses the same GET shape on its own fixture deal where relevant'],
];

// ── Report ───────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const modeParts = [READ_ONLY ? 'read-only' : 'read + write (cleaned up)'];
if (EXTENDED) modeParts.push('extended');
if (RUN_AI) modeParts.push('AI');
const lines = [
  `# Avise API smoke test`,
  ``,
  `- Host: ${BASE}`,
  `- Run: ${new Date().toISOString()}`,
  `- Key acts as: ${me.json?.email} (${me.json?.role}), org "${me.json?.organization?.name}"`,
  `- Mode: ${modeParts.join(' + ')}`,
  `- Result: **${passed}/${results.length} passed**, ${failed.length} failed`,
  ``,
  `| Result | Status | Expected | Method | Path | ms | Note / error |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.pass ? 'PASS' : '**FAIL**'} | ${r.status} | ${r.expected} | ${r.method} | \`${r.path}\` | ${r.ms} | ${[r.note, r.detail].filter(Boolean).join(' — ').replace(/\|/g, '/')} |`),
  ``,
  `Skipped on purpose: endpoints that send email or e-signature requests, invite users, change organization settings,`,
  `connect integrations, run AI generation (except --ai), Outreach (single-org feature) and Avise staff-only routes.`,
  ``,
  `## Not tested (and why)`,
  ``,
  `| Method | Path | Reason |`,
  `| --- | --- | --- |`,
  ...NOT_TESTED.map(([m, p, reason]) => `| ${m} | \`${p}\` | ${reason} |`),
];
writeFileSync('api-test-report.md', lines.join('\n') + '\n');
console.log(`\n${passed}/${results.length} passed, ${failed.length} failed. Report: ${process.cwd()}/api-test-report.md`);
process.exit(failed.length ? 1 : 0);
