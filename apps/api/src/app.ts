import * as Sentry from '@sentry/node';
import express, { type Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import dealsRouter from './routes/deals.js';
import companiesRouter from './routes/companies.js';
import activitiesRouter from './routes/activities.js';
import documentsRouter from './routes/documents.js';
import documentsAlertsRouter from './routes/documents-alerts.js';
import watchlistRouter from './routes/watchlist.js';
import aiRouter from './routes/ai.js';
import foldersRouter from './routes/folders.js';
import usersRouter from './routes/users.js';
import chatRouter from './routes/chat.js';
import notificationsRouter from './routes/notifications.js';
import ingestRouter from './routes/ingest.js';
import memosRouter from './routes/memos.js';
import invitationsRouter from './routes/invitations.js';
import invitationsAcceptRouter from './routes/invitations-accept.js';
import templatesRouter from './routes/templates.js';
import auditRouter from './routes/audit.js';
import auditExportRouter from './routes/audit-export.js';
import tasksRouter from './routes/tasks.js';
import contactsRouter from './routes/contacts.js';
import exportRouter from './routes/export.js';
import financialsRouter from './routes/financials.js';
import onboardingRouter from './routes/onboarding.js';
import dealImportRouter from './routes/deal-import.js';
import integrationsRouter from './routes/integrations.js';
import integrationsPublicRouter from './routes/integrations-public.js';
import { registerProvider } from './integrations/_platform/registry.js';
import { granolaProvider } from './integrations/granola/index.js';
import { gmailProvider } from './integrations/gmail/index.js';
import { googleCalendarProvider } from './integrations/googleCalendar/index.js';
import { outlookProvider } from './integrations/outlook/index.js';
import { microsoft365Provider } from './integrations/microsoft365/index.js';
import legalDocumentsRouter from './routes/legal-documents.js';
import legalDocEsignRouter from './routes/legal-doc-esign.js';
import dropboxSignWebhookRouter from './routes/dropbox-sign-webhook.js';
import legalDocumentTemplatesRouter from './routes/legal-document-templates.js';
import dealAccessTimelineRouter from './routes/deal-access-timeline.js';
import dealsTrashRouter from './routes/deals-trash.js';
import dealsTeasersRouter from './routes/deals-teasers.js';
import firmTeaserRouter from './routes/firm-teaser.js';
import firmContextRouter from './routes/firm-context.js';
import organizationsRouter from './routes/organizations.js';
import orgStaffWebhookRouter from './routes/org-staff-webhook.js';
import authSessionsRouter from './routes/auth-sessions.js';
import authWorkspaceEmailRouter from './routes/auth-workspace-email.js';
import adminSecurityRouter from './routes/admin-security.js';
import adminSecurityDashboardRouter from './routes/admin-security-dashboard.js';
import internalRouter from './routes/internal-usage.js';
import usageRouter from './routes/usage.js';
import hubspotImportRouter from './routes/hubspot-import.js';
import graphsRouter from './routes/graphs.js';
import dealsFinancialsTimeseriesRouter from './routes/deals-financials-timeseries.js';
import { supabase } from './supabase.js';
import { authMiddleware, enforceOrgMfaMiddleware } from './middleware/auth.js';
import { apiKeyMiddleware } from './middleware/apiKeyAuth.js';
import apiKeysRouter from './routes/api-keys.js';
import { staffAccessLogger } from './middleware/staffAccessLogger.js';
import { orgMiddleware } from './middleware/orgScope.js';
import { usageContextMiddleware } from './middleware/usageContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { isAIEnabled } from './openai.js';
import { MODEL_REASONING } from './utils/aiModels.js';
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
  log.info('Sentry error tracking initialized');
}

const app = express();

// Response compression (gzip)
app.use(compression());

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

// Trust proxy — required when running behind Vercel/Render/nginx so that
// express-rate-limit reads the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// CORS - whitelist allowed origins (configurable via ALLOWED_ORIGINS env var)
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = [
  'https://lmmos.ai',
  'https://www.lmmos.ai',
  'https://pe-dealstack.vercel.app',
  'https://pe-dealstack-nextjs.vercel.app',
  ...extraOrigins,
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003', 'http://localhost:5173'] : []),
];
const previewOriginRegex = /^https:\/\/pe-dealstack(-nextjs)?-[a-z0-9-]+\.vercel\.app$/;
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin || allowedOrigins.includes(origin) || previewOriginRegex.test(origin)) {
      callback(null, true);
    } else {
      log.warn('CORS request rejected', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting - protect API from abuse
// Use Authorization header as key so each user gets their own bucket,
// falling back to IP for unauthenticated requests.
// This prevents Vercel CDN IP sharing from causing false 429s.
const rateLimitKeyGenerator = (req: express.Request) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return 'user:' + authHeader.slice(-16);
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) {
    return 'key:' + apiKey.slice(-16);
  }
  // Fallback to forwarded IP header (Vercel/proxy) or socket address
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 'unknown';
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // 600 requests per 15 min per user (was 200 — too low for SPA navigation)
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 AI requests per minute (expensive calls)
  message: { error: 'Too many AI requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 writes per minute
  message: { error: 'Too many write operations, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyGenerator,
});

app.use('/api/', generalLimiter);
app.use('/api/ai', aiLimiter);
app.use('/api/memos/*/chat', aiLimiter);
app.use('/api/memos/*/sections/*/generate', aiLimiter);
app.use('/api/ingest', writeLimiter);

// API-key auth (machine callers). When x-api-key is present this fully
// authenticates the request; the JWT middlewares below skip via req.apiKey.
app.use('/api', apiKeyMiddleware);

app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request ID for error correlation
app.use(requestIdMiddleware);

// Health check - fast response (no DB query)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Readiness check - comprehensive service health
app.get('/health/ready', async (_req, res) => {
  const checks: { timestamp: string; status: string; services: Record<string, { ok: boolean; latencyMs?: number; configured?: boolean }> } = {
    timestamp: new Date().toISOString(),
    status: 'checking',
    services: {},
  };

  try {
    const dbStart = Date.now();
    const { error: dbError } = await supabase
      .from('Deal')
      .select('count', { count: 'exact', head: true });
    checks.services.database = { ok: !dbError, latencyMs: Date.now() - dbStart };

    checks.services.openai = {
      ok: !!process.env.OPENAI_API_KEY,
      configured: !!process.env.OPENAI_API_KEY,
    };

    checks.services.gemini = {
      ok: !!process.env.GEMINI_API_KEY,
      configured: !!process.env.GEMINI_API_KEY,
    };

    checks.services.sentry = {
      ok: !!process.env.SENTRY_DSN,
      configured: !!process.env.SENTRY_DSN,
    };

    const allHealthy = Object.values(checks.services).every(s => s.ok);
    checks.status = allHealthy ? 'healthy' : 'degraded';

    res.status(allHealthy ? 200 : 503).json(checks);
  } catch (err) {
    checks.status = 'unhealthy';
    res.status(503).json(checks);
  }
});

// API routes
app.get('/api', (_req, res) => {
  res.json({
    message: 'AI CRM API v0.1.0',
    endpoints: {
      deals: '/api/deals',
      companies: '/api/companies',
      activities: '/api/activities',
      documents: '/api/documents',
      folders: '/api/deals/:dealId/folders',
      users: '/api/users',
      conversations: '/api/conversations',
      notifications: '/api/notifications',
      invitations: '/api/invitations',
      templates: '/api/templates',
      ai: '/api/ai',
      ingest: '/api/ingest',
      health: '/health',
    },
  });
});

// ========================================
// Public Routes (no auth required)
// ========================================
// Invitation verify/accept must be public — invitees don't have accounts yet
app.use('/api/public/invitations', invitationsAcceptRouter);

// Integration webhooks + OAuth callbacks must be public — providers POST/GET
// here without an auth header. Auth is enforced via signed state tokens
// (callbacks) or per-provider signature verification (webhooks).
// MUST be mounted BEFORE the authenticated /api/integrations router below,
// since Express matches routes in registration order.
app.use('/api/integrations', integrationsPublicRouter);

// Dropbox Sign eSignature webhook — public (HMAC-verified), mounted before auth.
app.use('/api/webhooks', dropboxSignWebhookRouter);

// ========================================
// Protected Routes (require authentication + org resolution)
// ========================================
app.use('/api/deals/import', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealImportRouter);
// access-timeline mounted BEFORE the generic dealsRouter so /:dealId/access-timeline
// matches first (Express picks the first matching route in registration order)
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealAccessTimelineRouter);
// trash + restore endpoints — mounted before dealsRouter for the same path-precedence reason
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsTrashRouter);
// financials-timeseries: literal /:dealId/financials/timeseries path —
// mount BEFORE the generic dealsRouter so the literal segments match
// before deals-list.ts's /:id catch-all.
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsFinancialsTimeseriesRouter);
// Firm-teaser per-deal routes: literal /:id/teasers shape — mount BEFORE the
// generic dealsRouter so it matches before deals-list.ts's /:id catch-all.
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsTeasersRouter);
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsRouter);
app.use('/api/firm-teaser', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, firmTeaserRouter);
app.use('/api/firm-context', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, firmContextRouter);
app.use('/api/companies', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, companiesRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, activitiesRouter);
app.use('/api/documents', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, documentsAlertsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, documentsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, foldersRouter);
app.use('/api/users', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, usersRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, chatRouter);
app.use('/api/notifications', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, notificationsRouter);
app.use('/api/ingest', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, ingestRouter);
app.use('/api/memos', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, memosRouter);
app.use('/api/templates', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, templatesRouter);
// CustomGraph CRUD — /api/graphs and /api/deals/:dealId/graphs both
// live in this router so they share validation + org-scope checks.
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, graphsRouter);
app.use('/api/invitations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, invitationsRouter);
// Audit export must be mounted BEFORE the generic /api/audit router so /export.csv matches first
app.use('/api/audit', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, auditExportRouter);
app.use('/api/audit', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, auditRouter);
// staff-access-webhook router mounted BEFORE the generic organizationsRouter
// so /me/staff-access-webhook matches first (PATCH /me would otherwise catch it)
app.use('/api/organizations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, orgStaffWebhookRouter);
app.use('/api/organizations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, organizationsRouter);
app.use('/api/tasks', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, tasksRouter);
app.use('/api/export', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, exportRouter);
app.use('/api/onboarding', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, onboardingRouter);
// More-specific /hubspot prefix MUST be mounted BEFORE the generic
// integrationsRouter, whose POST /:provider/connect would otherwise capture
// /api/integrations/hubspot/connect (:provider="hubspot") and return 404.
app.use('/api/integrations/hubspot', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, hubspotImportRouter);
app.use('/api/integrations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, integrationsRouter);
// Dashboard mounted alongside the existing isolation-test router (different paths).
app.use('/api/admin/security', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, adminSecurityDashboardRouter);
app.use('/api/admin/security', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, adminSecurityRouter);
// API key management (admin-only via requireRole inside the router)
app.use('/api/api-keys', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, apiKeysRouter);
// Auth-scoped self-service routes (MFA bypass active for /api/auth/* in middleware)
app.use('/api/auth', authMiddleware, authSessionsRouter);
app.use('/api/auth', authMiddleware, authWorkspaceEmailRouter);
app.use('/api/contacts', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, contactsRouter);
app.use('/api/watchlist', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, watchlistRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, financialsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocumentsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocEsignRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocumentTemplatesRouter);
app.use('/api/usage', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, usageRouter);

// ========================================
// Internal Admin Routes (requireInternalAdmin gate inside router)
// No orgMiddleware — these routes intentionally query across orgs
// ========================================
app.use('/api/internal', authMiddleware, internalRouter);

// ========================================
// AI Routes (mixed - some protected, some public)
// ========================================
// AI deal chat and analysis endpoints (require auth + org)
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, aiRouter);

// AI status endpoint (public - no auth required)
app.get('/api/ai/status', (_req, res) => {
  res.json({
    enabled: isAIEnabled(),
    model: MODEL_REASONING,
  });
});

// Register integration providers (must execute before any request)
registerProvider(granolaProvider);
registerProvider(gmailProvider);
registerProvider(googleCalendarProvider);
registerProvider(outlookProvider);
registerProvider(microsoft365Provider);

// Sentry error handler (must be before custom error handler)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Global error handling middleware
app.use(errorHandler);

export default app;
