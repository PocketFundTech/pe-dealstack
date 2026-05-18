/**
 * Error Handler Sentry Integration Tests
 *
 * Verifies that the global Express error handler reports 5xx errors to Sentry
 * via Sentry.captureException, with proper scope context and PII redaction.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 3 Task 3.5
 * Refs: .planning/codebase/CONCERNS.md §8.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

// Mock @sentry/node BEFORE importing the error handler. vi.mock is hoisted
// above any top-level const, so the mock factory must build its own state
// via vi.hoisted. Tests pull the same references back out of vi.hoisted.
const sentryMocks = vi.hoisted(() => {
  const scope = {
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
const withScopeMock = sentryMocks.withScope;
const scopeMock = sentryMocks.scope;

// Mock logger so test output stays clean.
vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks are wired up.
import {
  errorHandler,
  AppError,
  ServiceUnavailableError,
  ValidationError,
} from '../src/middleware/errorHandler.js';

function createMockContext(overrides: Partial<Request> = {}) {
  const req = {
    method: 'GET',
    path: '/api/deals/123',
    originalUrl: '/api/deals/123?expand=true',
    query: { expand: 'true' },
    headers: {
      authorization: 'Bearer super-secret-token',
      cookie: 'session=abc123',
    },
    body: { password: 'hunter2', creditCard: '4242-4242-4242-4242' },
    user: {
      id: 'user-uuid-42',
      email: 'alice@example.com',
      role: 'MEMBER',
      organizationId: 'org-uuid-7',
    },
    ...overrides,
  } as unknown as Request;

  const res = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('errorHandler Sentry integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a generic 500 error to Sentry with captureException', () => {
    const { req, res, next } = createMockContext();
    const err = new Error('Database connection lost');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // The original error should be passed through so Sentry can extract its
    // stack trace and message.
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it('does NOT send 4xx ZodError validation errors to Sentry', () => {
    const { req, res, next } = createMockContext();
    // Build a real ZodError to exercise the existing classification branch.
    const zodErr = new ZodError([
      {
        code: 'invalid_type',
        path: ['email'],
        message: 'Required',
        expected: 'string',
        received: 'undefined',
      } as any,
    ]);

    errorHandler(zodErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(withScopeMock).not.toHaveBeenCalled();
  });

  it('attaches route + user scope but never request body or headers', () => {
    const { req, res, next } = createMockContext();
    const err = new Error('Boom');

    errorHandler(err, req, res, next);

    expect(withScopeMock).toHaveBeenCalledTimes(1);

    // Route tag carries method + originalUrl so Sentry groups by endpoint.
    expect(scopeMock.setTag).toHaveBeenCalledWith(
      'route',
      'GET /api/deals/123?expand=true'
    );

    // User identity flows through — id + organizationId only.
    expect(scopeMock.setUser).toHaveBeenCalledWith({
      id: 'user-uuid-42',
      organizationId: 'org-uuid-7',
    });

    // Request context contains method/path/query but explicitly omits
    // body and headers (PII / secret leakage prevention).
    const requestContextCall = scopeMock.setContext.mock.calls.find(
      ([name]) => name === 'request'
    );
    expect(requestContextCall).toBeDefined();
    const requestContext = requestContextCall![1] as Record<string, unknown>;
    expect(requestContext).not.toHaveProperty('body');
    expect(requestContext).not.toHaveProperty('headers');
    expect(requestContext).not.toHaveProperty('cookie');

    // Make sure no other setContext / setExtra call smuggled the body or
    // headers in under a different key.
    const allContextValues = [
      ...scopeMock.setContext.mock.calls.map(c => JSON.stringify(c[1])),
      ...scopeMock.setExtra.mock.calls.map(c => JSON.stringify(c[1])),
    ].join('\n');
    expect(allContextValues).not.toContain('hunter2');
    expect(allContextValues).not.toContain('super-secret-token');
    expect(allContextValues).not.toContain('4242-4242-4242-4242');
    expect(allContextValues).not.toContain('session=abc123');
  });

  it('sends custom 503 ServiceUnavailableError to Sentry', () => {
    const { req, res, next } = createMockContext();
    const err = new ServiceUnavailableError('OpenAI');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it('does not send a custom 400 ValidationError to Sentry', () => {
    const { req, res, next } = createMockContext();
    const err = new ValidationError('Bad input', [{ field: 'email' }]);

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('handles missing req.user gracefully when reporting 5xx', () => {
    const { req, res, next } = createMockContext({ user: undefined });
    const err = new AppError('Internal blowup', 500, 'INTERNAL_ERROR');

    errorHandler(err, req, res, next);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // setUser should still be invoked, with undefined id/organizationId.
    expect(scopeMock.setUser).toHaveBeenCalledWith({
      id: undefined,
      organizationId: undefined,
    });
  });
});
