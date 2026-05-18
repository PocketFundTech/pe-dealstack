/**
 * API Error Handling Middleware
 * Provides consistent error responses and logging
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import * as Sentry from '@sentry/node';
import { log } from '../utils/logger.js';

// Custom error classes for different error types
export class AppError extends Error {
  statusCode: number;
  code: string;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true; // Distinguishes operational errors from programming errors
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  details: any[];

  constructor(message: string, details: any[] = []) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests. Please try again later.') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string = 'Service') {
    super(`${service} is currently unavailable`, 503, 'SERVICE_UNAVAILABLE');
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Invalid request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

export class DatabaseError extends AppError {
  constructor(message: string = 'Database operation failed') {
    super(message, 500, 'DATABASE_ERROR');
  }
}

// Error response interface
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any[];
    requestId?: string;
  };
}

/**
 * Format error for client response
 */
function formatErrorResponse(
  err: any,
  requestId?: string,
  includeStack: boolean = false
): ErrorResponse {
  const response: ErrorResponse = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred',
    },
  };

  if (requestId) {
    response.error.requestId = requestId;
  }

  // Include details for validation errors
  if (err instanceof ValidationError || err instanceof ZodError) {
    response.error.details = err instanceof ZodError ? err.errors : err.details;
  }

  // Include stack trace in development only
  if (includeStack && process.env.NODE_ENV === 'development') {
    (response.error as any).stack = err.stack;
  }

  return response;
}

/**
 * Handle Zod validation errors
 */
function handleZodError(err: ZodError): ValidationError {
  const details = err.errors.map(e => ({
    field: e.path.join('.'),
    message: e.message,
    code: e.code,
  }));

  return new ValidationError('Validation failed', details);
}

/**
 * Handle Supabase/PostgreSQL errors
 */
function handleDatabaseError(err: any): AppError {
  const code = err.code;

  switch (code) {
    case '23505': // Unique violation
      return new ConflictError('A record with this value already exists');
    case '23503': // Foreign key violation
      return new ValidationError('Referenced record does not exist');
    case '23502': // Not null violation
      return new ValidationError('Required field is missing');
    case 'PGRST116': // No rows returned
      return new NotFoundError();
    case '42P01': // Undefined table
      return new AppError('Database configuration error', 500, 'DATABASE_ERROR');
    default:
      return new AppError('Database error occurred', 500, 'DATABASE_ERROR');
  }
}

/**
 * Log error for monitoring
 */
function logError(err: any, req: Request): void {
  const errorContext = {
    method: req.method,
    path: req.path,
    requestId: req.headers['x-request-id'] || (req as any).requestId,
    userId: req.user?.id,
    errorCode: err.code,
    statusCode: err.statusCode,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    isOperational: err.isOperational,
  };

  // Log at appropriate level
  if (err.statusCode >= 500) {
    log.error('Server error', err, errorContext);
  } else if (err.statusCode >= 400) {
    log.warn('Client error', { ...errorContext, message: err.message });
  }
}

/**
 * Main error handling middleware
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip if headers already sent
  if (res.headersSent) {
    return next(err);
  }

  let appError: AppError;

  // Convert known error types
  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = handleZodError(err);
  } else if (err.code && err.code.startsWith('PGRST')) {
    appError = handleDatabaseError(err);
  } else if (err.code && err.code.match(/^2\d{4}$/)) {
    // PostgreSQL error codes
    appError = handleDatabaseError(err);
  } else if (err.type === 'entity.parse.failed') {
    appError = new ValidationError('Invalid JSON in request body');
  } else if (err.message?.includes('File too large')) {
    appError = new ValidationError('File size exceeds maximum limit');
  } else {
    // Unknown error - treat as internal server error
    appError = new AppError(
      process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
      500,
      'INTERNAL_ERROR'
    );
    appError.isOperational = false;
  }

  // Log error
  logError(appError, req);

  // Report 5xx errors to Sentry with redacted request context.
  // 4xx errors are user errors (validation, auth, not-found) — not bugs, so
  // they stay out of Sentry to avoid noise. The Sentry SDK is a no-op when
  // not initialized (NODE_ENV !== 'production' or SENTRY_DSN unset), so this
  // block is safe to run in every environment.
  if (appError.statusCode >= 500) {
    Sentry.withScope(scope => {
      scope.setTag('route', `${req.method} ${req.originalUrl}`);
      scope.setUser({
        id: req.user?.id,
        organizationId: req.user?.organizationId,
      });
      // Deliberately omit headers and body — they routinely carry secrets
      // (Authorization, Cookie) or PII (passwords, payment fields).
      scope.setContext('request', {
        method: req.method,
        path: req.path,
        query: req.query,
        requestId: req.headers['x-request-id'] || (req as any).requestId,
        statusCode: appError.statusCode,
        errorCode: appError.code,
      });
      // Pass the original error so Sentry preserves the real stack trace
      // and message, not the wrapped/sanitized AppError.
      Sentry.captureException(err);
    });
  }

  // Send response
  const response = formatErrorResponse(
    appError,
    req.headers['x-request-id'] as string,
    process.env.NODE_ENV === 'development'
  );

  res.status(appError.statusCode).json(response);
}

/**
 * Handle 404 for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response = formatErrorResponse(
    new NotFoundError(`Route ${req.method} ${req.path}`),
    req.headers['x-request-id'] as string
  );
  res.status(404).json(response);
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  BadRequestError,
  DatabaseError,
};
