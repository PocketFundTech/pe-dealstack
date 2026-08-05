import * as Sentry from '@sentry/node';
import express, { type Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import dealsRouter from './routes/deals.js';
import companiesRouter from './routes/companies.js';
import activitiesRouter from './routes/activities.js';
import documentsRouter from './routes/documents.js';
import documentsAlertsRouter from './routes/documents-alerts.js';
import watchlistRouter from './routes/watchlist.js';
import foldersRouter from './routes/folders.js';
import usersRouter from './routes/users.js';
import notificationsRouter from './routes/notifications.js';
import invitationsRouter from './routes/invitations.js';
import invitationsAcceptRouter from './routes/invitations-accept.js';
import templatesRouter from './routes/templates.js';
import auditRouter from './routes/audit.js';
import tasksRouter from './routes/tasks.js';
import contactsRouter from './routes/contacts.js';
import exportRouter from './routes/export.js';
import dealImportRouter from './routes/deal-import.js';
import hubspotImportRouter from './routes/hubspot-import.js';
import internalRouter from './routes/internal-usage.js';
import usageRouter from './routes/usage.js';
import auditExportRouter from './routes/audit-export.js';
import organizationsRouter from './routes/organizations.js';
import orgStaffWebhookRouter from './routes/org-staff-webhook.js';
import authSessionsRouter from './routes/auth-sessions.js';
import authWorkspaceEmailRouter from './routes/auth-workspace-email.js';
import adminSecurityRouter from './routes/admin-security.js';
import adminSecurityDashboardRouter from './routes/admin-security-dashboard.js';
import dealAccessTimelineRouter from './routes/deal-access-timeline.js';
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
// (disabled — see banner below)
// import legalDocWebhooksRouter from './routes/legal-doc-webhooks.js';
import dealsTrashRouter from './routes/deals-trash.js';
import dealsTeasersRouter from './routes/deals-teasers.js';
import firmTeaserRouter from './routes/firm-teaser.js';
import firmContextRouter from './routes/firm-context.js';
import graphsRouter from './routes/graphs.js';
import dealsFinancialsTimeseriesRouter from './routes/deals-financials-timeseries.js';
import { supabase } from './supabase.js';
import { authMiddleware, enforceOrgMfaMiddleware } from './middleware/auth.js';
import { apiKeyMiddleware } from './middleware/apiKeyAuth.js';
import apiKeysRouter from './routes/api-keys.js';
import { orgMiddleware } from './middleware/orgScope.js';
import { usageContextMiddleware } from './middleware/usageContext.js';
import { staffAccessLogger } from './middleware/staffAccessLogger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware } from './middleware/requestId.js';
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
    // The Express adapter (proxyToExpress in apps/web-next) uses synthetic
    // req/res objects, so Sentry's HTTP auto-instrumentation has no real
    // http.Server to wrap. In @sentry/node v10 the broken wrapper recursively
    // re-emits errors on Server.emit, causing 5-minute timeouts on simple
    // requests like /api/notifications. setupExpressErrorHandler below still
    // captures thrown errors via the middleware chain.
    defaultIntegrations: false,
  });
  log.info('Sentry error tracking initialized');
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
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) {
    return 'key:' + apiKey.slice(-16);
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

app.use('/api/', generalLimiter);

// API-key auth (machine callers). When x-api-key is present this fully
// authenticates the request; the JWT middlewares below skip via req.apiKey.
app.use('/api', apiKeyMiddleware);

app.use(
  express.json({
    limit: '50mb',
    // Capture raw bytes for webhook HMAC verification — provider signatures
    // are computed over the raw body, not parsed JSON.
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
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
    message: 'AI CRM API v0.1.0 (lite)',
    endpoints: {
      deals: '/api/deals',
      companies: '/api/companies',
      activities: '/api/activities',
      documents: '/api/documents',
      folders: '/api/deals/:dealId/folders',
      users: '/api/users',
      notifications: '/api/notifications',
      invitations: '/api/invitations',
      templates: '/api/templates',
      health: '/health',
    },
  });
});

// ========================================
// Public Routes (no auth required)
// ========================================
// Invitation verify/accept must be public -- invitees don't have accounts yet
app.use('/api/public/invitations', invitationsAcceptRouter);

// Integration webhooks + OAuth callbacks + cron must be public — providers
// POST/GET here without an auth header. Auth is enforced via signed state
// tokens (callbacks), per-provider signature verification (webhooks), or
// shared CRON_SECRET (cron). MUST be mounted BEFORE the authenticated
// /api/integrations router below — Express matches routes in registration order.
app.use('/api/integrations', integrationsPublicRouter);

// Dropbox Sign eSignature webhook — provider POSTs signed-document events here
// with no auth header (authenticity = HMAC event_hash, verified in the route).
// MUST be mounted BEFORE the authenticated routers below.
app.use('/api/webhooks', dropboxSignWebhookRouter);

// ─── DISABLED UNTIL PROD (Drive push signature detection) ───────────────
// files.watch push needs a GCP-domain-verified HTTPS callback; *.vercel.app
// cannot be verified, so push never fires on preview/Vercel. Active detection
// now runs via on-demand polling (legalDocSignaturePollService +
// POST /legal-documents/check-signatures). RE-ENABLE before prod — see
// docs/nda-signature-detection-setup.md "Enabling push in production".
// ────────────────────────────────────────────────────────────────────────
// Public: Google Drive POSTs NDA-signature notifications here with no auth header.
// Identity = signed channel token (X-Goog-Channel-Token) + resourceId match.
// app.use('/api/webhooks/legal-docs', legalDocWebhooksRouter);

// ========================================
// Protected Routes (require authentication + org resolution)
// ========================================
app.use('/api/deals/import', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealImportRouter);
// access-timeline mounted BEFORE the generic dealsRouter so /:dealId/access-timeline matches first
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealAccessTimelineRouter);
app.use('/api/deals', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, dealsTrashRouter);
// financials-timeseries mounted BEFORE dealsRouter so /:dealId/financials/timeseries matches first
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
app.use('/api/notifications', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, notificationsRouter);
app.use('/api/templates', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, templatesRouter);
// CustomGraph CRUD — /api/graphs and /api/deals/:dealId/graphs
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, graphsRouter);
// Authenticated invitation routes (list, create, revoke, resend)
app.use('/api/invitations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, invitationsRouter);
// audit-export must be mounted BEFORE the generic auditRouter so /export.csv matches first
app.use('/api/audit', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, auditExportRouter);
app.use('/api/audit', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, auditRouter);
// staff-access-webhook router mounted BEFORE generic organizationsRouter so /me/staff-access-webhook matches first
app.use('/api/organizations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, orgStaffWebhookRouter);
app.use('/api/organizations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, organizationsRouter);
app.use('/api/tasks', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, tasksRouter);
app.use('/api/export', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, exportRouter);
app.use('/api/contacts', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, contactsRouter);
app.use('/api/watchlist', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, watchlistRouter);
// hubspot import mounted BEFORE the generic integrationsRouter so /hubspot/* isn't
// swallowed by integrationsRouter's /:provider/connect catch-all.
app.use('/api/integrations/hubspot', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, hubspotImportRouter);
app.use('/api/integrations', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, integrationsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocumentsRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocEsignRouter);
app.use('/api', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, legalDocumentTemplatesRouter);

// Admin security: dashboard router mounted BEFORE the isolation-test router (different paths but ordered for clarity)
app.use('/api/admin/security', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, adminSecurityDashboardRouter);
app.use('/api/admin/security', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, adminSecurityRouter);

// API key management (admin-only via requireRole inside the router)
app.use('/api/api-keys', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, apiKeysRouter);

// Auth-scoped self-service routes (MFA bypass active for /api/auth/* in middleware)
app.use('/api/auth', authMiddleware, authSessionsRouter);
app.use('/api/auth', authMiddleware, authWorkspaceEmailRouter);

// User-facing usage rollup (org-scoped)
app.use('/api/usage', authMiddleware, orgMiddleware, enforceOrgMfaMiddleware, usageContextMiddleware, staffAccessLogger, usageRouter);

// Internal admin (Pocket Fund team only — gate is inside the router via requireInternalAdmin)
// Note: NO orgMiddleware — internal routes intentionally query across orgs.
app.use('/api/internal', authMiddleware, internalRouter);

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
