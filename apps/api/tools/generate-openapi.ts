#!/usr/bin/env -S npx tsx
/**
 * Generates the Avise OpenAPI 3.1 spec from the single source of truth —
 * apps/web-next/src/app/api-reference/endpoint-index.ts, the same list the
 * public /api-reference page renders (315+ endpoints, regenerated whenever
 * routes change — see docs/all_endpoints generation note there).
 *
 * Usage:
 *   npx tsx apps/api/tools/generate-openapi.ts
 *
 * Writes apps/web-next/public/openapi.json, served statically at
 * https://app.avise.io/openapi.json (no auth needed — it's just a schema).
 * n8n, Postman, Insomnia and most API clients import an OpenAPI URL directly.
 *
 * This script adds hand-written detail (summary, description, request body
 * example, path-parameter descriptions) for the ~45 most-used endpoints —
 * the same ones documented on the api-reference page — and falls back to a
 * generated summary + generic path parameters for the rest, so every one of
 * the 315+ endpoints has a usable (if terse) entry.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_INDEX, ENDPOINT_TOTAL, type HttpMethod } from '../../web-next/src/app/api-reference/endpoint-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../../web-next/public/openapi.json');

// ── Curated detail for the most-used endpoints ──────────────────────────
// Keyed by "METHOD path" exactly as it appears in endpoint-index.ts.
interface Detail {
  summary: string;
  description?: string;
  requestBodyExample?: Record<string, unknown>;
  successStatus?: number; // default: POST=201, DELETE=204, else 200
  params?: Record<string, string>; // override a path param's description
}

const DETAILS: Record<string, Detail> = {
  'GET /api/users/me': {
    summary: 'Get the key’s owner',
    description: 'Returns the admin this key acts as, with their organization. The simplest way to test a key.',
  },
  'GET /api/deals': {
    summary: 'List deals',
    description: 'Plain array, newest activity first. Supports `updatedSince` for polling, and `offset`+`limit` for paging (paging only applies once `offset` is sent).',
  },
  'POST /api/deals': {
    summary: 'Create a deal',
    requestBodyExample: { name: 'Project Falcon', companyName: 'Falcon Logistics', industry: 'Logistics', revenue: 42.5, ebitda: 6.1, dealSize: 120, priority: 'HIGH', source: 'n8n', tags: ['inbound'] },
  },
  'GET /api/deals/:id': { summary: 'Get a deal', description: 'Includes company, team, documents, activities and folders.' },
  'PATCH /api/deals/:id': {
    summary: 'Update a deal',
    requestBodyExample: { stage: 'DUE_DILIGENCE', stageNote: 'Management call went well' },
  },
  'DELETE /api/deals/:id': { summary: 'Move a deal to trash', description: 'Soft delete (204). Restore with `POST /api/deals/:id/restore`.' },
  'GET /api/deals/stats/summary': { summary: 'Pipeline counts', description: 'Total, active, passed deals and a count per stage.' },
  'GET /api/contacts': { summary: 'List contacts', description: 'Paged: `{ contacts, total, limit, offset }`.' },
  'POST /api/contacts': {
    summary: 'Create a contact',
    requestBodyExample: { firstName: 'Priya', lastName: 'Shah', email: 'priya@bank.com', company: 'Example Bank', type: 'BANKER', tags: ['mid-market'] },
  },
  'GET /api/contacts/:id': { summary: 'Get a contact', description: 'Includes interactions and linked deals.' },
  'PATCH /api/contacts/:id': { summary: 'Update a contact' },
  'DELETE /api/contacts/:id': { summary: 'Delete a contact' },
  'POST /api/contacts/import': {
    summary: 'Bulk-create contacts',
    description: 'Up to 500 per call.',
    requestBodyExample: { contacts: [{ firstName: 'Priya', lastName: 'Shah', email: 'priya@bank.com' }] },
  },
  'POST /api/contacts/:id/deals': { summary: 'Link a contact to a deal', requestBodyExample: { dealId: '00000000-0000-0000-0000-000000000000' } },
  'GET /api/companies': { summary: 'List companies', description: 'All companies with their deals.' },
  'GET /api/companies/list': {
    summary: 'Companies page list',
    description: 'Paged `{ companies, total, limit, offset }` with `dealCount` (soft-deleted deals excluded), `contactCount` (contacts whose free-text company matches the name, case-insensitively) and `source` (`hubspot` | `avise`). Query: `search`, `hasDeals` (all|yes|no), `source` (all|hubspot|avise), `sortBy` (name|updatedAt), `sortOrder`, `limit` (≤100), `offset`.',
  },
  'GET /api/companies/:id/overview': {
    summary: 'Company overview',
    description: 'One company with its live deals and up to 100 name-matched contacts (`contactTotal` has the full count).',
  },
  'POST /api/companies': { summary: 'Create a company', requestBodyExample: { name: 'Falcon Logistics', industry: 'Logistics', website: 'https://falconlogistics.com' } },
  'GET /api/tasks': { summary: 'List tasks', description: 'Paged: `{ tasks, count, limit, offset }`.' },
  'GET /api/tasks/:id': { summary: 'Get a task' },
  'POST /api/tasks': {
    summary: 'Create a task',
    requestBodyExample: { title: 'Request Q3 management accounts', dealId: '00000000-0000-0000-0000-000000000000', priority: 'HIGH', dueDate: '2026-10-15' },
  },
  'GET /api/deals/:dealId/activities': { summary: 'Get a deal’s activity feed', description: 'Newest first: `{ data, total, limit, offset }`.' },
  'POST /api/deals/:dealId/activities': {
    summary: 'Add a note or log activity',
    description: 'Use `NOTE_ADDED` for a note. Emails in `mentionedEmails` notify those teammates.',
    requestBodyExample: { type: 'NOTE_ADDED', title: 'Banker call', description: 'Seller wants to close by Q1.' },
  },
  'GET /api/deals/:dealId/documents': { summary: 'List a deal’s documents' },
  'POST /api/deals/:dealId/documents': {
    summary: 'Upload a document',
    description: 'Multipart form data, file in a field named `file` (PDF, Excel, CSV, Word, .msg, .eml, JPG, PNG). Up to 4.5 MB this way — use the signed upload for larger files. Avise reads the file with AI after responding.',
  },
  'POST /api/uploads/sign': {
    summary: 'Get a signed upload URL',
    description: 'For files over 4.5 MB: PUT the bytes to the returned URL, then call the upload or ingest endpoint with the `storagePath`.',
    requestBodyExample: { fileName: 'CIM.pdf', contentType: 'application/pdf', size: 18200000, purpose: 'data-room', dealId: '00000000-0000-0000-0000-000000000000' },
  },
  'GET /api/documents/:id/download': { summary: 'Download a document' },
  'POST /api/ingest/text': {
    summary: 'Create a deal from pasted text (AI)',
    description: '50+ characters, e.g. a banker email. Pass `dealId` to update an existing deal instead.',
    requestBodyExample: { text: 'Deal content text...', sourceType: 'email', sourceName: 'Inbound from banker' },
  },
  'POST /api/ingest/url': {
    summary: 'Research a company from its website (AI)',
    requestBodyExample: { url: 'https://acme.com', companyName: 'Acme Corp', autoCreateDeal: true },
  },
  'POST /api/ingest': { summary: 'Create a deal from a file (AI)', description: 'Multipart, field `file` (CIM, teaser, financials).' },
  'POST /api/ingest/email': { summary: 'Create a deal from an .eml email (AI)' },
  'POST /api/ingest/bulk': { summary: 'Bulk-import deals from Excel/CSV (AI)', description: 'One deal per row.' },
  'GET /api/memos': { summary: 'List memos', params: { dealId: 'Filter to one deal' } },
  'POST /api/memos': {
    summary: 'Create a memo',
    requestBodyExample: { dealId: '00000000-0000-0000-0000-000000000000', title: 'Investment Memo - Acme Corp', type: 'IC_MEMO' },
  },
  'POST /api/memos/:id/generate-all': { summary: 'Generate every memo section (AI)' },
  'POST /api/memos/:id/sections/:sectionId/generate': { summary: 'Regenerate one memo section (AI)' },
  'GET /api/users/me/team': { summary: 'List your organization’s team' },
  'GET /api/export/deals': { summary: 'Export deals', params: { format: 'csv or json (default json)' } },
  'GET /api/audit': { summary: 'List audit log entries', description: 'Paged.' },
  'GET /api/webhook-subscriptions': { summary: 'List webhooks' },
  'POST /api/webhook-subscriptions': {
    summary: 'Add a webhook',
    description: 'The signing secret is returned once. See the webhook events table on /api-reference.',
    requestBodyExample: { url: 'https://your-n8n.example.com/webhook/avise', events: ['deal.created', 'deal.stage_changed'] },
  },
  'PATCH /api/webhook-subscriptions/:id': { summary: 'Update a webhook', requestBodyExample: { active: false } },
  'DELETE /api/webhook-subscriptions/:id': { summary: 'Delete a webhook' },
  'POST /api/webhook-subscriptions/:id/test': { summary: 'Send a test event' },
  'GET /api/webhook-subscriptions/events': { summary: 'List supported webhook events' },
  'GET /api/organizations/me': { summary: 'Get your organization' },
  'GET /api/notifications': { summary: 'List notifications', params: { userId: 'Required — from GET /api/users/me' } },
};

// ── Path-parameter descriptions (generic, by segment name) ──────────────
const PARAM_DESCRIPTIONS: Record<string, string> = {
  id: 'The record’s id',
  dealId: 'The deal’s id',
  contactId: 'The contact’s id',
  documentId: 'The document’s id',
  sectionId: 'The section’s id',
  statementId: 'The financial statement’s id',
  folderId: 'The folder’s id',
  itemId: 'The item’s id',
  shareId: 'The share link’s id',
  graphId: 'The graph’s id',
  memberId: 'The team member’s id',
  entityId: 'The audited record’s id',
  connectionId: 'The connection’s id',
  provider: 'The integration provider, e.g. gmail, google_calendar',
  token: 'The one-time token from the link',
  userId: 'The user’s id',
};

function humanizeSegment(seg: string): string {
  return seg
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function autoSummary(method: HttpMethod, path: string, groupTitle: string): string {
  const segs = path.replace(/^\/api\//, '').split('/');
  const last = segs[segs.length - 1];
  const isParam = last.startsWith(':');
  const noun = humanizeSegment(isParam ? segs.filter((s) => !s.startsWith(':')).pop() ?? groupTitle : last);
  const verb = { GET: isParam || segs.some((s) => s.startsWith(':')) ? 'Get' : 'List', POST: 'Create or run', PUT: 'Replace', PATCH: 'Update', DELETE: 'Delete' }[method];
  return `${verb} ${noun.toLowerCase()}`;
}

function pathParams(path: string, detail?: Detail) {
  const names = [...path.matchAll(/:([a-zA-Z0-9]+)/g)].map((m) => m[1]);
  return names.map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    description: detail?.params?.[name] ?? PARAM_DESCRIPTIONS[name] ?? `The ${humanizeSegment(name).toLowerCase()}`,
    schema: { type: 'string' as const },
  }));
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z0-9]+)/g, '{$1}');
}

function defaultSuccess(method: HttpMethod): number {
  if (method === 'POST') return 201;
  if (method === 'DELETE') return 204;
  return 200;
}

const ERROR_RESPONSES = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/TooManyRequests' },
};

const paths: Record<string, Record<string, unknown>> = {};

for (const group of ENDPOINT_INDEX) {
  for (const [method, rawPath] of group.endpoints) {
    const key = `${method} ${rawPath}`;
    const detail = DETAILS[key];
    const openApiPath = toOpenApiPath(rawPath);
    const successCode = String(detail?.successStatus ?? defaultSuccess(method));
    const op: Record<string, unknown> = {
      summary: detail?.summary ?? autoSummary(method, rawPath, group.title),
      tags: [group.title],
      operationId: `${method.toLowerCase()}_${rawPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
    };
    const descriptionParts = [detail?.description, group.note].filter(Boolean);
    if (descriptionParts.length) op.description = descriptionParts.join(' ');

    const params = pathParams(rawPath, detail);
    if (params.length) op.parameters = params;

    if (detail?.requestBodyExample) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'object' }, example: detail.requestBodyExample } },
      };
    } else if (['POST', 'PUT', 'PATCH'].includes(method) && !rawPath.includes('documents') && !rawPath.includes('ingest') && !rawPath.includes('/upload')) {
      op.requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
    }

    op.responses = {
      [successCode]: {
        description: successCode === '204' ? 'No content' : 'Success',
        ...(successCode === '204' ? {} : { content: { 'application/json': { schema: { type: 'object' } } } }),
      },
      ...ERROR_RESPONSES,
    };

    paths[openApiPath] ??= {};
    paths[openApiPath][method.toLowerCase()] = op;
  }
}

const tags = ENDPOINT_INDEX.map((g) => ({ name: g.title, description: g.note ?? `Endpoints for ${g.title.toLowerCase()}.` }));

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Avise API',
    version: '1.0.0',
    description:
      'Connect n8n, Zapier, Make or your own scripts to Avise. Create an API key in **Settings → API Keys** ' +
      '(full access or read-only) and send it as a Bearer token. Full guide: https://app.avise.io/api-reference. ' +
      `${ENDPOINT_TOTAL} endpoints below, generated from the live route code.`,
  },
  servers: [{ url: 'https://app.avise.io', description: 'Production' }],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  tags,
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'avise_sk_...',
        description: 'Authorization: Bearer avise_sk_…',
      },
      apiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'X-API-Key: avise_sk_… (counted against its own rate limit, unlike a malformed Bearer value)',
      },
    },
    responses: {
      BadRequest: { description: 'A field is missing or invalid — see `details` in the response body.' },
      Unauthorized: { description: 'The API key is missing, wrong, revoked or expired.' },
      Forbidden: { description: 'The key’s owner lacks permission, MFA is required, the key is read-only and this is a write request (`API_KEY_READ_ONLY`), or this endpoint is session-login only.' },
      NotFound: { description: 'No matching record in your organization.' },
      TooManyRequests: { description: 'Rate limit reached — see the `RateLimit-Reset` header.' },
    },
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(spec, null, 2) + '\n');

const pathCount = Object.values(paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
console.log(`Wrote ${OUT_PATH}`);
console.log(`${Object.keys(paths).length} path templates, ${pathCount} operations (expected ${ENDPOINT_TOTAL}).`);
console.log(`${Object.keys(DETAILS).length} operations have hand-written summaries/examples; the rest are auto-generated.`);
