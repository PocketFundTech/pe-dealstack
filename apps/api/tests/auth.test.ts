/**
 * Auth Middleware Security Tests
 * Tests authentication, token validation, and role-based access control
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock supabase before importing auth middleware
vi.mock('../src/supabase.js', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks are set up
import { authMiddleware, optionalAuthMiddleware, requireRole } from '../src/middleware/auth.js';
import { supabase } from '../src/supabase.js';

// Helper to create mock request/response/next
function createMockContext() {
  const req = {
    headers: {},
    user: undefined,
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('should reject requests without Authorization header', async () => {
      const { req, res, next } = createMockContext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'No authorization header provided',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests without Bearer prefix', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Basic sometoken';

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Use Bearer token.',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject requests with empty token', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer ';

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'No token provided',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject invalid/expired tokens', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer invalid_token';

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token', name: 'AuthError', status: 401 },
      });

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should attach user to request for valid tokens', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        user_metadata: {
          full_name: 'Test User',
          firm_name: 'Test Firm',
          role: 'ADMIN',
        },
      };

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      await authMiddleware(req, res, next);

      expect(req.user).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        firmName: 'Test Firm',
        role: 'ADMIN',
        user_metadata: mockUser.user_metadata,
        // The mock user has no email_confirmed_at.
        emailConfirmed: false,
      });
      expect(next).toHaveBeenCalled();
    });

    it('should default to MEMBER role when not specified', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        user_metadata: {
          full_name: 'Test User',
        },
      };

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      await authMiddleware(req, res, next);

      expect(req.user?.role).toBe('MEMBER');
      expect(next).toHaveBeenCalled();
    });

    it('should handle user without email gracefully', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      const mockUser = {
        id: 'user-123',
        email: null,
        user_metadata: {},
      };

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      await authMiddleware(req, res, next);

      expect(req.user?.email).toBe('');
      expect(next).toHaveBeenCalled();
    });

    it('should return 500 on unexpected errors', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      vi.mocked(supabase.auth.getUser).mockRejectedValue(new Error('Database error'));

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal Server Error',
        message: 'Authentication failed',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should continue without user when no token provided', async () => {
      const { req, res, next } = createMockContext();

      await optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should attach user when valid token provided', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        user_metadata: { role: 'MEMBER' },
      };

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      await optionalAuthMiddleware(req, res, next);

      expect(req.user?.id).toBe('user-123');
      expect(next).toHaveBeenCalled();
    });

    it('should continue without user when token is invalid', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer invalid_token';

      vi.mocked(supabase.auth.getUser).mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid', name: 'AuthError', status: 401 },
      });

      await optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('should silently continue on errors', async () => {
      const { req, res, next } = createMockContext();
      req.headers.authorization = 'Bearer valid_token';

      vi.mocked(supabase.auth.getUser).mockRejectedValue(new Error('Network error'));

      await optionalAuthMiddleware(req, res, next);

      expect(req.user).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireRole', () => {
    it('should return 401 when no user is attached', () => {
      const { req, res, next } = createMockContext();
      const middleware = requireRole('ADMIN');

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when user lacks required role', () => {
      const { req, res, next } = createMockContext();
      req.user = { id: 'user-123', email: 'test@example.com', role: 'VIEWER' };
      const middleware = requireRole('ADMIN');

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'This action requires one of the following roles: ADMIN',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow access when user has required role', () => {
      const { req, res, next } = createMockContext();
      req.user = { id: 'user-123', email: 'test@example.com', role: 'ADMIN' };
      const middleware = requireRole('ADMIN');

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow access when user has any of the allowed roles', () => {
      const { req, res, next } = createMockContext();
      req.user = { id: 'user-123', email: 'test@example.com', role: 'MEMBER' };
      const middleware = requireRole('ADMIN', 'MEMBER');

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should list all allowed roles in error message', () => {
      const { req, res, next } = createMockContext();
      req.user = { id: 'user-123', email: 'test@example.com', role: 'VIEWER' };
      const middleware = requireRole('ADMIN', 'MEMBER');

      middleware(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: 'This action requires one of the following roles: ADMIN, MEMBER',
      });
    });
  });
});

describe('Auth Security Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not leak token information in error messages', async () => {
    const { req, res, next } = createMockContext();
    req.headers.authorization = 'Bearer secret_token_12345';

    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: 'Token expired', name: 'AuthError', status: 401 },
    });

    await authMiddleware(req, res, next);

    const jsonCall = vi.mocked(res.json).mock.calls[0][0];
    expect(JSON.stringify(jsonCall)).not.toContain('secret_token_12345');
  });

  it('should handle malformed Authorization header gracefully', async () => {
    const { req, res, next } = createMockContext();
    req.headers.authorization = 'Bearer';

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    // "Bearer" without space doesn't match "Bearer " prefix, so it returns invalid format
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Invalid authorization header format. Use Bearer token.',
    });
  });

  it('should handle very long tokens without crashing', async () => {
    const { req, res, next } = createMockContext();
    const veryLongToken = 'x'.repeat(10000);
    req.headers.authorization = `Bearer ${veryLongToken}`;

    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token', name: 'AuthError', status: 401 },
    });

    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should handle tokens with special characters', async () => {
    const { req, res, next } = createMockContext();
    req.headers.authorization = 'Bearer token_with_special=chars+and/slashes';

    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid', name: 'AuthError', status: 401 },
    });

    await authMiddleware(req, res, next);

    expect(supabase.auth.getUser).toHaveBeenCalledWith('token_with_special=chars+and/slashes');
  });

  it('should handle concurrent requests with different tokens', async () => {
    const context1 = createMockContext();
    const context2 = createMockContext();

    context1.req.headers.authorization = 'Bearer token1';
    context2.req.headers.authorization = 'Bearer token2';

    vi.mocked(supabase.auth.getUser)
      .mockResolvedValueOnce({
        data: { user: { id: 'user-1', email: 'user1@example.com', user_metadata: {} } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: { id: 'user-2', email: 'user2@example.com', user_metadata: {} } },
        error: null,
      });

    await Promise.all([
      authMiddleware(context1.req, context1.res, context1.next),
      authMiddleware(context2.req, context2.res, context2.next),
    ]);

    expect(context1.req.user?.id).toBe('user-1');
    expect(context2.req.user?.id).toBe('user-2');
  });
});
