# PE OS — Security & Data Protection

## Overview

PE OS is an AI-powered deal management platform built for private equity firms handling confidential investment data — CIMs, financial models, legal documents, and proprietary deal intelligence. Security is foundational to our architecture, not an afterthought.

This document details our security controls, infrastructure certifications, and data protection practices.

---

## Infrastructure & Certifications

All PE OS data is processed and stored on **SOC 2 Type II certified infrastructure**:

| Provider | Role | Certification |
|----------|------|---------------|
| **Supabase** | Database, Authentication, File Storage | SOC 2 Type II |
| **Vercel** | Application Hosting (Serverless) | SOC 2 Type II |
| **OpenAI** | AI Processing (GPT-4o) | SOC 2 Type II |

No PE OS data is stored on unmanaged servers or developer machines. All production infrastructure is managed by enterprise-grade cloud providers.

---

## Encryption

### Data at Rest
- PostgreSQL database encrypted with **AES-256** at rest (Supabase managed)
- File storage encrypted at rest via Supabase Storage infrastructure
- Application-level **AES-256-GCM** encryption available for sensitive fields
- Encryption key management via environment variables (never stored in code)

### Data in Transit
- All traffic encrypted in transit using **TLS 1.2 or higher** (TLS 1.3 negotiated when supported by client). HTTPS enforced via HSTS.
- **HSTS** headers with 1-year max-age, includeSubDomains, and preload
- API ↔ Database connections encrypted via Supabase internal networking

### Document Storage
- All deal documents stored in a **private storage bucket** — no public access
- Document access requires authenticated API call → generates **time-limited signed URLs** (1-hour expiry)
- Signed URLs cannot be guessed, shared permanently, or accessed after expiration
- Every document download is logged in the immutable audit trail

---

## Authentication & Access Control

### Authentication
- Email/password authentication via **Supabase Auth** (enterprise-grade, JWT-based)
- **Two-Factor Authentication (2FA)** — TOTP-based, compatible with Google Authenticator, Authy, and all standard authenticator apps
- Minimum 10-character passwords with uppercase, lowercase, number, and special character requirements
- Automatic token refresh with 1-hour JWT expiry
- Failed login attempts logged with IP address and user agent

### Authorization
- **Role-Based Access Control (RBAC)** with 9 roles: Admin, Partner, Principal, VP, Associate, Member, Analyst, Operations, Viewer
- **20+ granular permissions** mapped to roles
- **Organization isolation** — every API endpoint verifies the requesting user's organization owns the resource
- Cross-organization data access returns 404 (not 403) to prevent resource enumeration
- **Row-Level Security (RLS)** enabled on all database tables as defense-in-depth

### Tenant Isolation

PE OS enforces hard organizational data isolation at the application layer:

- Every database row in scoped tables is tagged with `organizationId`
- All API route handlers verify access via centralized access-verification helpers (`verifyDealAccess()` / `verifyContactAccess()` / `verifyDocumentAccess()` / `verifyFolderAccess()` / `verifyConversationAccess()`)
- 268 org-scope verification calls across 45 route files (verified 2026-04-30)
- 34 automated cross-organization integration tests run on every deploy — these tests actively attempt cross-org reads/writes and verify all are rejected
- Backend uses a separate service role key (never exposed to clients)

---

## API Security

### Rate Limiting

PE OS enforces three tiers of rate limiting at the API gateway:

| Tier | Endpoint Scope | Limit | Window |
|------|---------------|-------|--------|
| General | All `/api/*` requests | 600 | 15 min |
| AI | `/api/ai/*`, memo chat | 10 | 1 min |
| Write | All POST/PUT/PATCH/DELETE | 30 | 1 min |

Rate limits are keyed by authenticated user ID (falling back to client IP via `X-Forwarded-For`). Exceeding a limit returns HTTP 429 with `Retry-After` headers.

### Input Validation
- All API inputs validated with **Zod schemas** (type-safe, strict validation)
- Parameterized queries via Supabase PostgREST — zero SQL injection surface
- Frontend output escaping via `escapeHtml()` on all user-generated content

### Security Headers
- **Content-Security-Policy** (CSP) — restricts script/style/image sources
- **X-Frame-Options: DENY** — prevents clickjacking
- **X-Content-Type-Options: nosniff** — prevents MIME sniffing
- **Strict-Transport-Security** — enforces HTTPS
- **Referrer-Policy: strict-origin-when-cross-origin**

### CORS
- Whitelisted origins only (production domain + configurable extras)
- Localhost origins excluded in production
- Unknown origins rejected and logged

---

## File Upload Security

- **Magic bytes verification** — validates actual file content matches declared MIME type
- **Filename sanitization** — removes path traversal characters, control characters, and dangerous extensions
- **Dangerous content detection** — rejects files containing executable signatures (MZ, ELF, Mach-O, shell scripts)
- **File size limits** per type (100MB PDFs, 50MB Excel, 20MB CSV)
- **MIME type allowlist** — only business document formats accepted (PDF, Excel, CSV, Word, Images)

---

## Audit Logging

- **25+ tracked event types** including: login, logout, deal CRUD, document upload/download/delete, memo operations, user management, AI operations, invitation workflows
- **Immutable audit trail** — insert-only, no updates or deletes permitted
- Each entry captures: who (userId, email, role), what (action, resource), when (timestamp), and context (IP address, user agent, request ID)
- **Severity levels**: Info, Warning, Error, Critical
- **2-year retention** with automated cleanup
- Row-Level Security ensures only Admins/Partners can view audit logs

---

## AI & Data Processing

- AI features use **OpenAI GPT-4o** (SOC 2 Type II certified)
- OpenAI does not train on customer data (enterprise API)
- Financial extraction results are validated against source documents
- AI-generated content is clearly labeled with confidence scores
- No customer data is sent to third parties beyond the AI provider

---

## Secure Development Practices

- Conventional commit standards with code review
- TypeScript strict mode for type safety
- Centralized error handling — no stack traces in production
- Environment variables for all secrets (never hardcoded)
- `.env` files gitignored — secrets managed via Vercel environment variables
- Sentry error tracking for production monitoring

---

## Incident Response

- Production errors tracked via **Sentry** with real-time alerting
- Request ID correlation across all API calls for forensic analysis
- Audit log provides complete activity trail for any security investigation

---

## Compliance Roadmap

| Status | Control |
|--------|---------|
| Done | AES-256 encryption at rest + in transit |
| Done | Two-factor authentication (TOTP) |
| Done | Role-based access control (9 roles, 20+ permissions) |
| Done | Organization isolation (34 automated tests) |
| Done | Immutable audit logging (25+ events, 2-year retention) |
| Done | Private document storage with signed URLs |
| Done | Security headers (CSP, HSTS, X-Frame-Options) |
| Done | Input validation and SQL injection prevention |
| Done | File upload security (magic bytes, sanitization) |
| Done | SOC 2 Type II certified infrastructure |
| Planned | SOC 2 Type II certification (via Vanta/Drata) |
| Planned | Penetration testing (third-party) |
| Planned | IP allowlisting for enterprise accounts |
| Planned | Data residency controls |
| Planned | SSO/SAML integration |

---

## Contact

For security questions or to request a detailed security assessment, contact: **security@peos.app**

---

*Last updated: April 2026*
