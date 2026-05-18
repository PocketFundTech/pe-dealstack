import * as Sentry from '@sentry/node';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import aiRouter from './routes/ai.js';
import chatRouter from './routes/chat.js';
import financialsRouter from './routes/financials.js';
import memosRouter from './routes/memos.js';
import ingestRouter from './routes/ingest.js';
import onboardingRouter from './routes/onboarding.js';
import { authMiddleware } from './middleware/auth.js';
import { orgMiddleware } from './middleware/orgScope.js';
import { usageContextMiddleware } from './middleware/usageContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { isAIEnabled } from './openai.js';
import { log } from './utils/logger.js';

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const optionalEnvVars = ['OPENAI_API_KEY', 'GEMINI_API_KEY'];

const missingRequired = requiredEnvVars.filter(key => !process.env[key]);
if (missingRequired.length > 0) {
  log.error('Missing required environment variables', undefined, { missing: missingRequired });
  throw new Error(`Missing required environment variables: ${missingRequired.join(', ')}`);
}

const missingOptional = optionalEnvVars.filter(key => !process.env[key]);
if (missingOptional.length > 0) {
  log.warn('Optional environment variables not set (some features disabled)', { missing: missingOptional });
}

// Warn about production-critical vars that will cause broken behavior
if (process.env.NODE_ENV === 'production') {
  const productionVars = ['APP_URL', 'RESEND_API_KEY', 'SENTRY_DSN', 'SUPABASE_SERVICE_ROLE_KEY', 'DATA_ENCRYPTION_KEY'];
  const missingProd = productionVars.filter(key => !process.env[key]);
  if (missingProd.length > 0) {
    log.warn('Production-recommended env vars missing (emails/error tracking may not work)', { missing: missingProd });
  }
}

// Initialize Sentry for error tracking (production only)
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // See app-lite.ts for the rationale — auto-HTTP instrumentation recurses
    // when the underlying server is the proxyToExpress fake req/res adapter.
    defaultIntegrations: false,
  });
  log.info('Sentry error tracking initialized (AI function)');
}

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://cdn.sheetjs.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co"],
      connectSrc: ["'self'", "https://*.supabase.co", "https://api.openai.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS - whitelist allowed origins (configurable via ALLOWED_ORIGINS env var)
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = [
  'https://lmmos.ai',
  'https://www.lmmos.ai',
  'https://pe-dealstack.vercel.app',
  ...extraOrigins,
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:5173'] : []),
];
// Vercel auto-aliases per branch and per deploy:
//   pe-dealstack-git-<branch>-<team>-<hash>.vercel.app
//   pe-dealstack-<hash>-<team>-<hash>.vercel.app
// Hardcoding each is impossible — match the project subdomain pattern.
const VERCEL_ALIAS_RE = /^https:\/\/pe-dealstack(-[a-z0-9-]+)?\.vercel\.app$/;
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin || allowedOrigins.includes(origin) || VERCEL_ALIAS_RE.test(origin)) {
      callback(null, true);
    } else {
      log.warn('CORS request rejected', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting - per-user via auth token, fallback to IP
const rateLimitKeyGenerator = (req: express.Request) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return 'user:' + authHeader.slice(-16);
  }
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 'unknown';
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many AI requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many write operations, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

app.use('/api/', generalLimiter);
app.use('/api/ai', aiLimiter);
app.use('/api/memos/*/chat', aiLimiter);
app.use('/api/memos/*/sections/*/generate', aiLimiter);
// Deal chat invokes a LangGraph ReAct agent — see app.ts for rationale.
app.use('/api/deals/*/chat', aiLimiter);
app.use('/api/ingest', writeLimiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request ID for error correlation
app.use(requestIdMiddleware);

// ========================================
// Protected Routes (require authentication + org resolution)
// ========================================
app.use('/api', authMiddleware, orgMiddleware, usageContextMiddleware, chatRouter);
app.use('/api/ingest', authMiddleware, orgMiddleware, usageContextMiddleware, ingestRouter);
app.use('/api/memos', authMiddleware, orgMiddleware, usageContextMiddleware, memosRouter);
app.use('/api/onboarding', authMiddleware, orgMiddleware, usageContextMiddleware, onboardingRouter);
app.use('/api', authMiddleware, orgMiddleware, usageContextMiddleware, financialsRouter);

// ========================================
// AI Routes (mixed - some protected, some public)
// ========================================
// AI deal chat and analysis endpoints (require auth + org)
app.use('/api', authMiddleware, orgMiddleware, usageContextMiddleware, aiRouter);

// AI status endpoint (public - no auth required)
app.get('/api/ai/status', (_req, res) => {
  res.json({
    enabled: isAIEnabled(),
    model: 'gpt-4o',
  });
});

// Sentry error handler (must be before custom error handler)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Global error handling middleware
app.use(errorHandler);

export default app;
