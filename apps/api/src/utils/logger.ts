/**
 * Structured Logger for Avise API
 * Uses Pino for fast, structured logging
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

// Create logger with appropriate configuration
const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Don't log sensitive fields
  redact: {
    paths: ['req.headers.authorization', 'password', 'token', 'apiKey'],
    censor: '[REDACTED]',
  },
});

// Export typed logger methods for convenience
export const log = {
  /** Debug level - development only */
  debug: (msg: string, data?: object) => logger.debug(data, msg),

  /** Info level - general operational info */
  info: (msg: string, data?: object) => logger.info(data, msg),

  /** Warn level - something unexpected but handled */
  warn: (msg: string, data?: object) => logger.warn(data, msg),

  /** Error level - something failed */
  error: (msg: string, error?: Error | unknown, data?: object) => {
    if (error instanceof Error) {
      logger.error({ ...data, err: { message: error.message, stack: error.stack } }, msg);
    } else {
      logger.error({ ...data, err: error }, msg);
    }
  },

  /** Create a child logger with context */
  child: (context: object) => logger.child(context),
};

// Default export for direct pino access
export default logger;
