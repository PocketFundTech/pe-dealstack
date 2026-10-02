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
  '/api/templates', '/api/watchlist', '/api/graphs', '/api/integrations', '/api/integrations/activities',
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

// ── Report ───────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
const lines = [
  `# Avise API smoke test`,
  ``,
  `- Host: ${BASE}`,
  `- Run: ${new Date().toISOString()}`,
  `- Key acts as: ${me.json?.email} (${me.json?.role}), org "${me.json?.organization?.name}"`,
  `- Mode: ${READ_ONLY ? 'read-only' : 'read + write (cleaned up)'}${RUN_AI ? ' + AI ingest' : ''}`,
  `- Result: **${passed}/${results.length} passed**, ${failed.length} failed`,
  ``,
  `| Result | Status | Expected | Method | Path | ms | Note / error |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.pass ? 'PASS' : '**FAIL**'} | ${r.status} | ${r.expected} | ${r.method} | \`${r.path}\` | ${r.ms} | ${[r.note, r.detail].filter(Boolean).join(' — ').replace(/\|/g, '/')} |`),
  ``,
  `Skipped on purpose: endpoints that send email or e-signature requests, invite users, change organization settings,`,
  `connect integrations, run AI generation (except --ai), Outreach (single-org feature) and Avise staff-only routes.`,
];
writeFileSync('api-test-report.md', lines.join('\n') + '\n');
console.log(`\n${passed}/${results.length} passed, ${failed.length} failed. Report: ${process.cwd()}/api-test-report.md`);
process.exit(failed.length ? 1 : 0);
