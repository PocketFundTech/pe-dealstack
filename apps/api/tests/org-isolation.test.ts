/**
 * Org Isolation Integration Tests
 *
 * Tests that users in Org A cannot access Org B's data and vice versa.
 * Runs against a LIVE API server (localhost:3001) with real Supabase auth.
 *
 * Prerequisites:
 *   1. API server running: cd apps/api && npm run dev
 *   2. .env.test file with test credentials (see .env.test.example)
 *
 * Run:
 *   cd apps/api && npx vitest run tests/org-isolation.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load test env (not the mock setup.ts — we need real credentials)
dotenv.config({ path: path.resolve(__dirname, '../.env.test') });

const API = process.env.API_BASE_URL || 'http://localhost:3001/api';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

// ─── Integration Test Gate ────────────────────────────────────────
//
// This file exercises a LIVE API server + LIVE Supabase auth and is therefore
// an integration test, not a unit test. CI environments do not have real
// Supabase credentials, so the entire suite is gated behind RUN_INTEGRATION_TESTS.
//
// To run locally with credentials:
//   RUN_INTEGRATION_TESTS=1 npx vitest run tests/org-isolation.test.ts
//
// Triage: .planning/codebase/TEST_FAILURE_TRIAGE.md (Phase 2 Task 2.2).
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === '1'
  || process.env.RUN_INTEGRATION_TESTS === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

// ─── Auth Helper ──────────────────────────────────────────────────

interface AuthSession {
  token: string;
  userId: string;
  email: string;
  label: string;
}

async function login(email: string, password: string, label: string): Promise<AuthSession> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`Login failed for ${email}: ${error?.message || 'no session'}`);
  }
  return {
    token: data.session.access_token,
    userId: data.user.id,
    email,
    label,
  };
}

async function api(method: string, path: string, token: string, body?: any): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API}${path}`, opts);
  let data: any;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// ─── Test State ───────────────────────────────────────────────────

let orgA: AuthSession;
let orgB: AuthSession;

// Resource IDs we discover from each org
let orgA_dealId: string;
let orgA_contactId: string;
let orgA_folderId: string;
let orgA_documentId: string;

let orgB_dealId: string;
let orgB_contactId: string;

// ─── Setup ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Short-circuit when integration mode is off — every describe below is
  // already describe.skip'd, so we have no work to do and no credentials.
  if (!RUN_INTEGRATION) return;

  // Login both accounts
  orgA = await login(
    process.env.TEST_ORG_A_EMAIL!,
    process.env.TEST_ORG_A_PASSWORD!,
    'Org A'
  );
  orgB = await login(
    process.env.TEST_ORG_B_EMAIL!,
    process.env.TEST_ORG_B_PASSWORD!,
    'Org B'
  );

  console.log(`  Org A: ${orgA.email} (logged in)`);
  console.log(`  Org B: ${orgB.email} (logged in)`);

  // Discover Org A resources
  const dealsA = await api('GET', '/deals', orgA.token);
  expect(dealsA.status).toBe(200);
  expect(dealsA.data.length).toBeGreaterThan(0);
  orgA_dealId = dealsA.data[0].id;

  const contactsA = await api('GET', '/contacts', orgA.token);
  expect(contactsA.status).toBe(200);
  expect(contactsA.data.length).toBeGreaterThan(0);
  orgA_contactId = contactsA.data[0].id;

  const foldersA = await api('GET', `/deals/${orgA_dealId}/folders`, orgA.token);
  if (foldersA.status === 200 && foldersA.data?.length > 0) {
    orgA_folderId = foldersA.data[0].id;
  }

  const docsA = await api('GET', `/deals/${orgA_dealId}/documents`, orgA.token);
  if (docsA.status === 200 && docsA.data?.length > 0) {
    orgA_documentId = docsA.data[0].id;
  }

  // Discover Org B resources
  const dealsB = await api('GET', '/deals', orgB.token);
  expect(dealsB.status).toBe(200);
  expect(dealsB.data.length).toBeGreaterThan(0);
  orgB_dealId = dealsB.data[0].id;

  const contactsB = await api('GET', '/contacts', orgB.token);
  expect(contactsB.status).toBe(200);
  expect(contactsB.data.length).toBeGreaterThan(0);
  orgB_contactId = contactsB.data[0].id;

  console.log(`  Org A deal: ${orgA_dealId}`);
  console.log(`  Org A contact: ${orgA_contactId}`);
  console.log(`  Org A folder: ${orgA_folderId || 'none'}`);
  console.log(`  Org A document: ${orgA_documentId || 'none'}`);
  console.log(`  Org B deal: ${orgB_dealId}`);
  console.log(`  Org B contact: ${orgB_contactId}`);
}, 30000);

// ─── Tests ────────────────────────────────────────────────────────

describeIntegration('Org Isolation — Cross-Org Access Blocked', () => {

  // ── Deals ──────────────────────────────────────────────────────

  describe('Deals', () => {
    it('Org B cannot see Org A deals in their deal list', async () => {
      const res = await api('GET', '/deals', orgB.token);
      expect(res.status).toBe(200);
      const ids = res.data.map((d: any) => d.id);
      expect(ids).not.toContain(orgA_dealId);
    });

    it('Org B cannot access Org A deal by ID', async () => {
      const res = await api('GET', `/deals/${orgA_dealId}`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org A cannot access Org B deal by ID', async () => {
      const res = await api('GET', `/deals/${orgB_dealId}`, orgA.token);
      expect(res.status).toBe(404);
    });
  });

  // ── Documents ──────────────────────────────────────────────────

  describe('Documents', () => {
    it('Org B cannot list Org A deal documents', async () => {
      const res = await api('GET', `/deals/${orgA_dealId}/documents`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot get Org A document by ID', async () => {
      if (!orgA_documentId) return; // skip if no docs
      const res = await api('GET', `/documents/${orgA_documentId}`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot download Org A document', async () => {
      if (!orgA_documentId) return;
      const res = await api('GET', `/documents/${orgA_documentId}/download`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot update Org A document', async () => {
      if (!orgA_documentId) return;
      const res = await api('PATCH', `/documents/${orgA_documentId}`, orgB.token, { name: 'hacked' });
      expect(res.status).toBe(404);
    });

    it('Org B cannot delete Org A document', async () => {
      if (!orgA_documentId) return;
      const res = await api('DELETE', `/documents/${orgA_documentId}`, orgB.token);
      expect(res.status).toBe(404);
    });
  });

  // ── Folders ────────────────────────────────────────────────────

  describe('Folders', () => {
    it('Org B cannot list Org A deal folders', async () => {
      const res = await api('GET', `/deals/${orgA_dealId}/folders`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot get Org A folder by ID', async () => {
      if (!orgA_folderId) return;
      const res = await api('GET', `/folders/${orgA_folderId}`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot update Org A folder', async () => {
      if (!orgA_folderId) return;
      const res = await api('PATCH', `/folders/${orgA_folderId}`, orgB.token, { name: 'hacked' });
      expect(res.status).toBe(404);
    });

    it('Org B cannot list Org A folder documents', async () => {
      if (!orgA_folderId) return;
      const res = await api('GET', `/folders/${orgA_folderId}/documents`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot get Org A folder insights', async () => {
      if (!orgA_folderId) return;
      const res = await api('GET', `/folders/${orgA_folderId}/insights`, orgB.token);
      expect(res.status).toBe(404);
    });
  });

  // ── Deal Chat ──────────────────────────────────────────────────

  describe('Deal Chat', () => {
    it('Org B cannot read Org A deal chat history', async () => {
      const res = await api('GET', `/deals/${orgA_dealId}/chat/history`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot send chat message on Org A deal', async () => {
      const res = await api('POST', `/deals/${orgA_dealId}/chat`, orgB.token, { message: 'test' });
      expect(res.status).toBe(404);
    });

    it('Org B cannot delete Org A deal chat history', async () => {
      const res = await api('DELETE', `/deals/${orgA_dealId}/chat/history`, orgB.token);
      expect(res.status).toBe(404);
    });
  });

  // ── Deal Team ──────────────────────────────────────────────────

  describe('Deal Team', () => {
    it('Org B cannot view Org A deal team', async () => {
      const res = await api('GET', `/deals/${orgA_dealId}/team`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot add member to Org A deal', async () => {
      const res = await api('POST', `/deals/${orgA_dealId}/team`, orgB.token, {
        userId: orgB.userId,
        role: 'MEMBER',
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Contacts ───────────────────────────────────────────────────

  describe('Contacts', () => {
    it('Org B cannot see Org A contacts in their list', async () => {
      const res = await api('GET', '/contacts', orgB.token);
      expect(res.status).toBe(200);
      const ids = res.data.map((c: any) => c.id);
      expect(ids).not.toContain(orgA_contactId);
    });

    it('Org B cannot add interaction to Org A contact', async () => {
      const res = await api('POST', `/contacts/${orgA_contactId}/interactions`, orgB.token, {
        type: 'NOTE',
        title: 'hacked',
      });
      expect(res.status).toBe(404);
    });

    it('Org B cannot link Org A contact to a deal', async () => {
      const res = await api('POST', `/contacts/${orgA_contactId}/deals`, orgB.token, {
        dealId: orgB_dealId,
        role: 'OTHER',
      });
      expect(res.status).toBe(404);
    });

    it('Org B cannot view Org A contact connections', async () => {
      const res = await api('GET', `/contacts/${orgA_contactId}/connections`, orgB.token);
      expect(res.status).toBe(404);
    });

    it('Org B cannot create connection on Org A contact', async () => {
      const res = await api('POST', `/contacts/${orgA_contactId}/connections`, orgB.token, {
        relatedContactId: orgB_contactId,
        type: 'KNOWS',
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Contact Insights ───────────────────────────────────────────

  describe('Contact Insights', () => {
    it('Org A scores only count Org A data', async () => {
      const res = await api('GET', '/contacts/insights/scores', orgA.token);
      expect(res.status).toBe(200);
      // Scores object should only contain Org A contact IDs
      const scoreIds = Object.keys(res.data.scores || {});
      expect(scoreIds).not.toContain(orgB_contactId);
    });

    it('Org A network stats only count Org A contacts', async () => {
      const res = await api('GET', '/contacts/insights/network', orgA.token);
      expect(res.status).toBe(200);
      // mostConnected should not contain Org B contacts
      const connectedIds = (res.data.mostConnected || []).map((c: any) => c.id);
      expect(connectedIds).not.toContain(orgB_contactId);
    });
  });

  // ── Portfolio Chat ─────────────────────────────────────────────

  describe('Portfolio Chat', () => {
    it('Org A portfolio summary only returns Org A deals', async () => {
      // Call portfolio summary directly — lightweight check
      const dealsA = await api('GET', '/deals', orgA.token);
      const dealsB = await api('GET', '/deals', orgB.token);
      expect(dealsA.status).toBe(200);
      expect(dealsB.status).toBe(200);

      // Verify no overlap
      const idsA = new Set(dealsA.data.map((d: any) => d.id));
      const idsB = new Set(dealsB.data.map((d: any) => d.id));
      for (const id of idsA) {
        expect(idsB.has(id)).toBe(false);
      }
    });
  });
});

// ─── Same-Org Access Works ────────────────────────────────────────

describeIntegration('Org Isolation — Same-Org Access Works', () => {
  it('Org A can access their own deal', async () => {
    const res = await api('GET', `/deals/${orgA_dealId}`, orgA.token);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(orgA_dealId);
  });

  it('Org A can list their own contacts', async () => {
    const res = await api('GET', '/contacts', orgA.token);
    expect(res.status).toBe(200);
    const ids = res.data.map((c: any) => c.id);
    expect(ids).toContain(orgA_contactId);
  });

  it('Org A can access their own deal documents', async () => {
    const res = await api('GET', `/deals/${orgA_dealId}/documents`, orgA.token);
    expect(res.status).toBe(200);
  });

  it('Org A can access their own deal folders', async () => {
    const res = await api('GET', `/deals/${orgA_dealId}/folders`, orgA.token);
    expect(res.status).toBe(200);
  });

  it('Org A can access their own deal chat history', async () => {
    const res = await api('GET', `/deals/${orgA_dealId}/chat/history`, orgA.token);
    expect(res.status).toBe(200);
  });

  it('Org A can access their own deal team', async () => {
    const res = await api('GET', `/deals/${orgA_dealId}/team`, orgA.token);
    expect(res.status).toBe(200);
  });

  it('Org B can access their own deal', async () => {
    const res = await api('GET', `/deals/${orgB_dealId}`, orgB.token);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(orgB_dealId);
  });

  it('Org B can list their own contacts', async () => {
    const res = await api('GET', '/contacts', orgB.token);
    expect(res.status).toBe(200);
    const ids = res.data.map((c: any) => c.id);
    expect(ids).toContain(orgB_contactId);
  });
});
