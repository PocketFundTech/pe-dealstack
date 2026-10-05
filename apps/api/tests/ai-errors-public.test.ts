/**
 * QA #14 (1 Oct 2026): the Deal Scorecard showed Anthropic's raw error JSON
 * with the request id. Users must only ever see a classified message.
 */
import { describe, it, expect, vi } from 'vitest';

const errorLog = vi.fn();
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, debug() {}, error: (...a: unknown[]) => errorLog(...a) } }));

const { classifyAIErrorObject, classifyAIError, publicErrorMessage } = await import('../src/utils/aiErrors.js');

const anthropicCredit = Object.assign(
  new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_011CTx"}'),
  { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } },
);

describe('user-facing AI errors', () => {
  it('out-of-credit never shows the raw JSON or request id', () => {
    const r = classifyAIErrorObject(anthropicCredit);
    expect(r.statusCode).toBe(503);
    expect(r.userMessage).not.toMatch(/request_id|req_011|invalid_request_error|\{/);
  });

  it('logs one ai_quota_exhausted alert per instance', () => {
    classifyAIErrorObject(anthropicCredit);
    classifyAIErrorObject(anthropicCredit);
    const alerts = errorLog.mock.calls.filter((c) => String(c[0]).startsWith('ai_quota_exhausted'));
    expect(alerts).toHaveLength(1);
  });

  it('an unrecognised error falls back to a generic message, not the raw text', () => {
    expect(classifyAIError('Weird provider failure xyz-123 {"secret":"x"}')).toBe('The AI request failed. Please try again in a moment.');
  });

  it('publicErrorMessage keeps a route\'s own messages but classifies AI failures', () => {
    expect(publicErrorMessage(new Error('Could not download document file'), 'x')).toEqual({ message: 'Could not download document file' });
    const ai = publicErrorMessage(anthropicCredit, 'Financial extraction failed');
    expect(ai.statusCode).toBe(503);
    expect(ai.message).not.toMatch(/request_id/);
  });
});

describe('POST /api/deals/:id/scorecard with an out-of-credit provider', () => {
  it('returns a friendly 503, not the raw Anthropic JSON', async () => {
    vi.resetModules();
    vi.doMock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1', verifyDealAccess: async () => true }));
    vi.doMock('../src/services/agents/dealScorecard/index.js', () => ({
      scoreDeal: async () => { throw anthropicCredit; },
      CriteriaNotConfiguredError: class extends Error {},
    }));
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { default: router } = await import('../src/routes/deals-scorecard.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _r, next) => { req.user = { id: 'u', organizationId: 'org-1' }; next(); });
    app.use('/api/deals', router);
    const res = await request(app).post('/api/deals/deal-1/scorecard').send({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/request_id|req_011|invalid_request_error/);
    expect(res.body.error).toMatch(/^Couldn't score this deal/);
  });
});

describe('credit detection is precise (5 Oct, item 9)', () => {
  it('a non-credit error that mentions billing is not reported as out of credit', () => {
    const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: billing tier does not allow this model"}}'), { status: 400 });
    expect(classifyAIErrorObject(err).userMessage).not.toMatch(/credits are exhausted/);
  });

  it('OpenAI out-of-credit is still detected', () => {
    const err = Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), { status: 429, code: 'insufficient_quota' });
    expect(classifyAIErrorObject(err).userMessage).toMatch(/OpenAI.*credits are exhausted/);
  });

  it('an Anthropic workspace spend limit says so, not "credits exhausted"', () => {
    const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-11-01."}}'), { status: 400 });
    const msg = classifyAIErrorObject(err).userMessage;
    expect(msg).toMatch(/spending limit/);
    expect(msg).not.toMatch(/credits are exhausted/);
  });
});
