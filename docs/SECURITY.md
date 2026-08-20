# Avise Security Documentation

**For Y Combinator Due Diligence**
**Version:** 1.0
**Last Updated:** February 2026

---

## Executive Summary

Avise implements enterprise-grade security practices to protect sensitive private equity deal data. Our security architecture is designed around the principle of defense in depth, with multiple layers of protection at every level of the stack.

---

## Security Architecture

### Infrastructure Security

```
┌─────────────────────────────────────────────────────────────────┐
│                    HTTPS/TLS 1.3                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │ Rate Limiter│───▶│ Auth Layer │───▶│ Request Validation  │ │
│  │ (100/15min) │    │ (JWT/Bearer)│    │ (Zod Schemas)       │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               Application Logic                          │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │   │
│  │  │ XSS        │  │ Audit      │  │ Error              │ │   │
│  │  │ Prevention │  │ Logging    │  │ Sanitization       │ │   │
│  │  └────────────┘  └────────────┘  └────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               Data Layer (Supabase)                      │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │   │
│  │  │ Row Level  │  │ Encrypted  │  │ Automatic          │ │   │
│  │  │ Security   │  │ at Rest    │  │ Backups            │ │   │
│  │  └────────────┘  └────────────┘  └────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Authentication & Authorization

### Authentication

| Feature | Implementation |
|---------|----------------|
| **Identity Provider** | Supabase Auth (built on GoTrue) |
| **Token Format** | JWT (JSON Web Tokens) |
| **Token Storage** | HttpOnly cookies / localStorage |
| **Session Duration** | 1 hour (configurable) |
| **Refresh Tokens** | Yes, automatic refresh |

### Multi-Tenant Authorization

Avise is a multi-tenant application where each "firm" is isolated:

```typescript
// Firm-based data isolation
interface User {
  id: string;
  email: string;
  firmName: string;  // Tenant identifier
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
}

// All queries filter by firmName
const deals = await supabase
  .from('Deal')
  .select('*')
  .eq('firmName', user.firmName);  // Tenant isolation
```

### Role-Based Access Control (RBAC)

| Role | Permissions |
|------|-------------|
| **ADMIN** | Full access, manage users, invite members, delete deals |
| **MEMBER** | Create/edit deals, upload documents, use AI features |
| **VIEWER** | Read-only access to deals and documents |

```typescript
// Role enforcement middleware
app.delete('/api/deals/:id',
  authMiddleware,
  requireRole('ADMIN', 'MEMBER'),  // Only admin/member can delete
  deleteHandler
);
```

---

## Data Protection

### Encryption

| Layer | Method |
|-------|--------|
| **In Transit** | TLS 1.3 (enforced by Render) |
| **At Rest** | AES-256 (Supabase PostgreSQL) |
| **File Storage** | AES-256 (Supabase Storage) |
| **API Keys** | Environment variables (never in code) |

### Sensitive Data Handling

```typescript
// Structured logging - sensitive data excluded
log.info('User login', {
  userId: user.id,
  email: user.email,
  // NO password, NO tokens, NO API keys
});

// Error responses - no internal details exposed
res.status(500).json({
  error: 'Internal Server Error',
  message: 'An unexpected error occurred',
  requestId: req.requestId,  // For support correlation
  // NO stack traces, NO SQL errors, NO file paths
});
```

### Data Isolation

Each firm's data is logically isolated:

- All database queries include `firmName` filter
- Row Level Security (RLS) policies in Supabase
- No cross-firm data access possible via API

---

## Input Validation & Sanitization

### API Input Validation

All API endpoints use Zod schema validation:

```typescript
const createDealSchema = z.object({
  name: z.string().min(1).max(255),
  companyId: z.string().uuid().optional(),
  stage: z.enum(['INITIAL_REVIEW', 'DUE_DILIGENCE', 'LOI_SUBMITTED', 'CLOSED', 'PASSED']),
  dealSize: z.number().positive().optional(),
});

// Validation middleware
router.post('/deals', (req, res) => {
  const validation = createDealSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: 'Validation failed', details: validation.error.errors });
  }
  // Proceed with validated data
});
```

### File Upload Security

```typescript
// Multi-layer file validation
const fileValidation = {
  // 1. MIME type whitelist
  allowedTypes: ['application/pdf', 'image/png', 'image/jpeg', ...],

  // 2. Magic bytes verification
  magicBytes: {
    'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
    'image/png': [0x89, 0x50, 0x4E, 0x47],       // PNG header
  },

  // 3. Executable content detection
  dangerousPatterns: ['MZ', 'ELF', '#!', '<script>', '<?php'],

  // 4. File size limits (type-specific)
  sizeLimits: {
    'application/pdf': 100 * 1024 * 1024,  // 100MB
    'image/*': 10 * 1024 * 1024,           // 10MB
  },

  // 5. Filename sanitization
  sanitize: (filename) => filename.replace(/[<>:"|?*\/\\]/g, '_'),
};
```

### XSS Prevention

Frontend uses `escapeHtml()` utility for all dynamic content:

```javascript
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Usage
dealName.innerHTML = escapeHtml(deal.name);  // Safe
```

---

## API Security

### Rate Limiting

```typescript
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // 100 requests per window
  message: { error: 'Too many requests' },
  standardHeaders: true,
});
```

### CORS Configuration

```typescript
const allowedOrigins = [
  'https://pe-os.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
}));
```

### Request ID Correlation

Every request is assigned a unique ID for debugging and audit:

```typescript
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});
```

---

## Audit Logging

### What We Log

| Event | Data Captured |
|-------|---------------|
| User Login | userId, email, timestamp, IP |
| Deal Created/Updated | userId, dealId, changes, timestamp |
| Document Uploaded | userId, documentId, dealId, filename |
| Document Deleted | userId, documentId, dealId |
| Invitation Sent | inviterId, email, role |
| Invitation Accepted | invitationId, newUserId |
| Permission Changes | adminId, targetUserId, oldRole, newRole |

### Audit Log Structure

```typescript
await AuditLog.log(req, {
  action: 'DEAL_CREATED',
  resourceType: 'Deal',
  resourceId: deal.id,
  metadata: {
    dealName: deal.name,
    stage: deal.stage,
    firmName: user.firmName,
  },
});
```

### Log Retention

- Audit logs: 2 years (regulatory compliance)
- Application logs: 30 days
- Error logs: 90 days

---

## Third-Party Security

### Supabase

| Feature | Status |
|---------|--------|
| SOC 2 Type II | ✅ Certified |
| GDPR Compliant | ✅ Yes |
| Data Encryption | ✅ AES-256 |
| Automatic Backups | ✅ Daily |
| Point-in-time Recovery | ✅ 7 days |

### OpenAI

| Feature | Status |
|---------|--------|
| SOC 2 Type II | ✅ Certified |
| Data Retention | ✅ 0 days (API data not used for training) |
| Enterprise Agreement | Available for upgrade |

### Render

| Feature | Status |
|---------|--------|
| SOC 2 Type II | ✅ Certified |
| TLS 1.3 | ✅ Enforced |
| DDoS Protection | ✅ Included |
| Private Networking | Available (Pro tier) |

---

## Incident Response

### Severity Levels

| Level | Description | Response Time |
|-------|-------------|---------------|
| P0 | Data breach, service down | < 1 hour |
| P1 | Security vulnerability exploited | < 4 hours |
| P2 | Potential vulnerability discovered | < 24 hours |
| P3 | Security improvement needed | < 1 week |

### Response Procedure

1. **Detect** - Automated monitoring + user reports
2. **Assess** - Determine severity and scope
3. **Contain** - Stop ongoing attack/breach
4. **Eradicate** - Remove vulnerability
5. **Recover** - Restore normal operations
6. **Review** - Post-incident analysis

### Breach Notification

In case of data breach:
- Affected users notified within 72 hours
- Regulatory bodies notified as required
- Public disclosure if warranted

---

## Security Testing

### Automated Testing

| Test Type | Tool | Frequency |
|-----------|------|-----------|
| Unit Tests | Vitest | Every commit |
| Auth Tests | Custom | Every commit |
| File Validation | Custom | Every commit |
| Dependency Audit | npm audit | Weekly |

### Test Coverage (Security-Critical)

```
Auth Middleware Tests     - 22 tests ✅
File Validator Tests      - 41 tests ✅
Invitation Flow Tests     - 29 tests ✅
API Smoke Tests          - 36 tests ✅
─────────────────────────────────────
Total Security Tests     - 128 tests
```

### Manual Security Review

- Code review required for all PRs
- Security-focused review for auth/file changes
- Quarterly penetration testing (planned)

---

## Compliance Roadmap

### Current State

- [x] Secure authentication (Supabase Auth)
- [x] Data encryption (transit + rest)
- [x] Input validation (Zod schemas)
- [x] File upload security
- [x] Audit logging
- [x] Rate limiting
- [x] XSS prevention
- [x] CORS configuration
- [x] Structured logging (Pino)

### Planned Improvements

- [ ] SOC 2 Type II certification (Q3 2026)
- [ ] Penetration testing engagement (Q2 2026)
- [ ] Bug bounty program (Q4 2026)
- [ ] GDPR compliance documentation
- [ ] SSO/SAML integration
- [ ] IP whitelisting for enterprise
- [ ] Advanced threat monitoring

---

## Security Contacts

| Role | Contact |
|------|---------|
| Security Lead | hello@pocket-fund.com |
| Incident Response | hello@pocket-fund.com |
| Vulnerability Reports | hello@pocket-fund.com |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 2026 | Engineering | Initial security documentation |
