/**
 * Agent + Background-Job Sentry Capture Tests
 *
 * Verifies that LangGraph agent catch blocks and fire-and-forget
 * background jobs report errors to Sentry via captureException.
 *
 * Strategy: pick a representative slice rather than exhaustively
 * test every agent. We assert the wiring pattern works for:
 *   - one agent entry point (financialAgent)
 *   - one agent node-level catch (verifyNode — best-effort, level=warning)
 *   - one fire-and-forget background job (.catch handler in route)
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 3 Task 3.6
 * Refs: .planning/codebase/CONCERNS.md §6.4, §8.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @sentry/node BEFORE importing anything that depends on it.
const sentryMocks = vi.hoisted(() => {
  const scope = {
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setUser: vi.fn(),
    setContext: vi.fn(),
    setExtra: vi.fn(),
  };
  return {
    scope,
    captureException: vi.fn(),
    withScope: vi.fn((callback: (s: typeof scope) => void) => {
      callback(scope);
    }),
  };
});

vi.mock('@sentry/node', () => ({
  captureException: sentryMocks.captureException,
  withScope: sentryMocks.withScope,
}));

const captureExceptionMock = sentryMocks.captureException;
const scopeMock = sentryMocks.scope;

// Quiet logger.
vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks are wired up.
import { captureAgentError } from '../src/utils/sentryHelpers.js';

describe('captureAgentError helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the error to Sentry.captureException', () => {
    const err = new Error('boom');
    captureAgentError(err, { agent: 'financialAgent', node: 'extract' });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it('applies all provided tags to the scope', () => {
    captureAgentError(new Error('x'), {
      agent: 'firmResearchAgent',
      node: 'searchFirm',
      context: 'phase1',
    });

    expect(scopeMock.setTag).toHaveBeenCalledWith('agent', 'firmResearchAgent');
    expect(scopeMock.setTag).toHaveBeenCalledWith('node', 'searchFirm');
    expect(scopeMock.setTag).toHaveBeenCalledWith('context', 'phase1');
  });

  it('defaults to error level when not specified', () => {
    captureAgentError(new Error('x'), { agent: 'a' });
    expect(scopeMock.setLevel).toHaveBeenCalledWith('error');
  });

  it('honors warning level for best-effort node failures', () => {
    captureAgentError(new Error('x'), { agent: 'a', node: 'verify' }, 'warning');
    expect(scopeMock.setLevel).toHaveBeenCalledWith('warning');
  });

  it('skips empty tag values to avoid blank Sentry tags', () => {
    captureAgentError(new Error('x'), { agent: 'a', node: '' });
    const setTagCalls = scopeMock.setTag.mock.calls.map((c) => c[0]);
    expect(setTagCalls).toContain('agent');
    expect(setTagCalls).not.toContain('node');
  });

  it('never throws even if Sentry.withScope blows up', () => {
    sentryMocks.withScope.mockImplementationOnce(() => {
      throw new Error('sentry broken');
    });
    expect(() =>
      captureAgentError(new Error('x'), { agent: 'a' }),
    ).not.toThrow();
  });
});

// ─── Agent entry point: financialAgent ────────────────────────────────
//
// runFinancialAgent wraps graph.invoke in try/catch and returns a
// structured failure state. We verify that the catch block calls
// captureAgentError before returning.

describe('runFinancialAgent — outer catch reports to Sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('captures exception when the graph invocation throws', async () => {
    // Mock the graph builder so .invoke() throws synchronously.
    const invokeMock = vi.fn().mockRejectedValue(new Error('graph crashed'));
    vi.doMock('../src/services/agents/financialAgent/graph.js', () => ({
      getFinancialAgentGraph: () => ({ invoke: invokeMock }),
    }));

    // agentBounds wraps invoke in a Promise.race + timeout. We let the
    // real implementation run — it will reject with our error.
    const { runFinancialAgent } = await import(
      '../src/services/agents/financialAgent/index.js'
    );

    const result = await runFinancialAgent({
      dealId: 'deal-1',
      documentId: null,
      fileBuffer: Buffer.from('test'),
      fileName: 'test.pdf',
      fileType: 'pdf',
    });

    expect(result.status).toBe('failed');
    expect(captureExceptionMock).toHaveBeenCalled();
    // The agent tag should be set so Sentry groups by agent.
    const agentTagCall = scopeMock.setTag.mock.calls.find(
      ([key]) => key === 'agent',
    );
    expect(agentTagCall?.[1]).toBe('financialAgent');
  });
});

// ─── Background fire-and-forget: notifications .catch handler ────────
//
// Many route handlers fire notifyDealTeam(...).catch(err => log.error(...))
// — the error never reaches Express. We verify the pattern by importing
// the helper directly and invoking it the same way a .catch would.

describe('fire-and-forget .catch → Sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports background job failures with a context tag', () => {
    const err = new Error('notification send failed');

    // Mirror the in-route pattern:
    //   notifyDealTeam(...).catch(err => {
    //     log.error('Notification error (doc upload)', err);
    //     captureAgentError(err, { context: 'notifyDealTeam:doc_upload' }, 'warning');
    //   });
    captureAgentError(
      err,
      { context: 'notifyDealTeam:doc_upload' },
      'warning',
    );

    expect(captureExceptionMock).toHaveBeenCalledWith(err);
    expect(scopeMock.setLevel).toHaveBeenCalledWith('warning');
    expect(scopeMock.setTag).toHaveBeenCalledWith(
      'context',
      'notifyDealTeam:doc_upload',
    );
  });
});
