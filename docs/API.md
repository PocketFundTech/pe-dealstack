# PE OS API Documentation

**Version:** v0.1.0
**Base URL:** `https://pe-os.onrender.com/api` (Production)
**Local:** `http://localhost:3001/api`

---

## Authentication

All protected endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer <supabase_access_token>
```

Tokens are obtained through Supabase Auth (login/signup).

### API Keys (read-only, machine callers)

For agents, scripts, and integrations, a read-only API key can be sent instead of a Bearer token:

```
x-api-key: peos_<48 hex chars>
```

- Keys authenticate as the org with VIEWER permissions and only allow GET requests (403 on writes).
- Manage keys (ADMIN only, Bearer auth required):
  - `POST /api/api-keys` `{ "name": "reporting" }` → returns the raw key **once**
  - `GET /api/api-keys` → list keys (prefix, last used, creator; never the key itself)
  - `DELETE /api/api-keys/:id` → revoke
- Keys are stored as SHA-256 hashes. Creation/revocation are audit-logged (`API_KEY_CREATED` / `API_KEY_REVOKED`).

### Error Responses

| Code | Description |
|------|-------------|
| 401 | Missing or invalid token |
| 403 | Insufficient permissions (role-based) |
| 429 | Rate limit exceeded (100 req/15min) |

---

## Health & Status

### GET /health
Check API and database health.

**Auth Required:** No

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-06T10:30:00.000Z",
  "database": "connected"
}
```

### GET /api
Get API information and available endpoints.

**Auth Required:** No

**Response:**
```json
{
  "message": "AI CRM API v0.1.0",
  "endpoints": {
    "deals": "/api/deals",
    "companies": "/api/companies",
    "activities": "/api/activities",
    "documents": "/api/documents",
    "folders": "/api/deals/:dealId/folders",
    "users": "/api/users",
    "notifications": "/api/notifications",
    "invitations": "/api/invitations",
    "ai": "/api/ai",
    "ingest": "/api/ingest",
    "health": "/health"
  }
}
```

---

## Deals

### GET /api/deals
List all deals for the authenticated user's firm.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| stage | string | Filter by stage (INITIAL_REVIEW, DUE_DILIGENCE, LOI_SUBMITTED, CLOSED, PASSED) |
| status | string | Filter by status (ACTIVE, ON_HOLD, CLOSED) |
| industry | string | Filter by industry (partial match) |
| search | string | Search in name, industry |

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Apex Logistics",
    "stage": "DUE_DILIGENCE",
    "status": "ACTIVE",
    "industry": "Supply Chain SaaS",
    "dealSize": 48,
    "revenue": 48,
    "ebitda": 12.4,
    "irrProjected": 24.5,
    "mom": 3.5,
    "company": {
      "id": "company-uuid",
      "name": "Apex Logistics Corp"
    },
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-02-01T14:30:00.000Z"
  }
]
```

### GET /api/deals/:id
Get a single deal with full details.

**Response:** Includes all deal fields plus:
- `company` - Full company object
- `activities` - Recent activities
- `documents` - Associated documents
- `assignedUsers` - Team members

### POST /api/deals
Create a new deal.

**Request Body:**
```json
{
  "name": "New Deal",
  "companyId": "existing-company-uuid",
  "companyName": "Or Create New Company",
  "stage": "INITIAL_REVIEW",
  "status": "ACTIVE",
  "industry": "Healthcare Services",
  "dealSize": 50,
  "source": "Referral"
}
```

**Response:** `201 Created` with the new deal object.

### PATCH /api/deals/:id
Update a deal.

**Request Body:** Any deal fields to update.

### DELETE /api/deals/:id
Delete a deal.

**Response:** `204 No Content`

### GET /api/deals/stats/summary
Get deal pipeline statistics.

**Response:**
```json
{
  "total": 15,
  "active": 12,
  "passed": 3,
  "byStage": [
    { "stage": "INITIAL_REVIEW", "count": 5 },
    { "stage": "DUE_DILIGENCE", "count": 4 },
    { "stage": "LOI_SUBMITTED", "count": 2 },
    { "stage": "CLOSED", "count": 1 }
  ]
}
```

---

## Companies

### GET /api/companies
List all companies.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| search | string | Search in name, industry |
| industry | string | Filter by industry |

### GET /api/companies/:id
Get a single company with associated deals.

### POST /api/companies
Create a new company.

**Request Body:**
```json
{
  "name": "Acme Corporation",
  "industry": "Manufacturing",
  "website": "https://acme.com",
  "description": "Leading manufacturer of widgets"
}
```

### PATCH /api/companies/:id
Update a company.

### DELETE /api/companies/:id
Delete a company (requires no active deals).

---

## Documents

### GET /api/deals/:dealId/documents
List documents for a deal.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| type | string | Filter by type (CIM, TEASER, FINANCIALS, LEGAL, NDA, LOI, OTHER) |
| folderId | string | Filter by folder |
| search | string | Search in name |

### POST /api/deals/:dealId/documents
Upload a document.

**Content-Type:** `multipart/form-data`

**Form Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | The file to upload |
| name | string | No | Display name (defaults to filename) |
| type | string | No | Document type |
| folderId | string | No | Target folder ID |

**Supported File Types:**
- PDF (max 100MB)
- Excel (.xlsx, .xls - max 50MB)
- CSV (max 20MB)
- Word (.docx, .doc - max 25MB)
- Images (.jpg, .png - max 10MB)

**Security:** Files are validated with:
- MIME type verification
- Magic bytes validation
- Malicious content detection
- Filename sanitization

**Response:** `201 Created`
```json
{
  "id": "doc-uuid",
  "name": "CIM - Apex Logistics.pdf",
  "type": "CIM",
  "fileUrl": "https://storage.url/path/to/file",
  "fileSize": 2456789,
  "mimeType": "application/pdf",
  "status": "analyzed",
  "extractedText": "...",
  "extractedData": {
    "companyName": "Apex Logistics",
    "industry": "Supply Chain",
    "revenue": "48M"
  }
}
```

### GET /api/documents/:id
Get a single document.

### PATCH /api/documents/:id
Update document metadata.

### DELETE /api/documents/:id
Delete a document.

### GET /api/documents/:id/download
Get download URL for a document.

---

## Folders

### GET /api/deals/:dealId/folders
List folders for a deal (Virtual Data Room structure).

### POST /api/deals/:dealId/folders
Create a folder.

**Request Body:**
```json
{
  "name": "Financial Documents",
  "parentId": null
}
```

### PATCH /api/folders/:id
Update a folder.

### DELETE /api/folders/:id
Delete a folder (must be empty).

---

## Activities

### GET /api/deals/:dealId/activities
List activities for a deal.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| type | string | Filter by type |
| limit | number | Results per page (default: 50) |
| offset | number | Pagination offset |

**Response:**
```json
{
  "data": [
    {
      "id": "activity-uuid",
      "type": "NOTE_ADDED",
      "title": "Added meeting notes",
      "description": "Discussed valuation with management team",
      "user": { "id": "user-uuid", "name": "John Doe" },
      "createdAt": "2026-02-05T16:00:00.000Z"
    }
  ],
  "total": 45,
  "limit": 50,
  "offset": 0
}
```

### POST /api/deals/:dealId/activities
Create an activity.

**Request Body:**
```json
{
  "type": "NOTE_ADDED",
  "title": "Meeting with CEO",
  "description": "Discussed growth strategy..."
}
```

**Activity Types:**
- NOTE_ADDED, NOTE_UPDATED
- DOCUMENT_UPLOADED, DOCUMENT_DELETED
- STAGE_CHANGED, STATUS_CHANGED
- COMMENT_ADDED
- MEETING_SCHEDULED
- AI_ANALYSIS_RUN

---

## Users

### GET /api/users
List users in the authenticated user's firm.

### GET /api/users/me
Get current authenticated user.

**Response:**
```json
{
  "id": "user-uuid",
  "email": "john@firm.com",
  "name": "John Doe",
  "avatar": "https://...",
  "role": "ADMIN",
  "firmName": "Summit Partners",
  "aiPreferences": {
    "model": "gpt-4-turbo-preview",
    "firmContext": "Growth equity focus..."
  },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### PATCH /api/users/me
Update current user profile.

**Request Body:**
```json
{
  "name": "John Doe",
  "avatar": "https://...",
  "aiPreferences": {
    "model": "gpt-4-turbo-preview",
    "firmContext": "We focus on B2B SaaS..."
  }
}
```

---

## Invitations

### GET /api/invitations
List invitations for the current user's firm.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| status | string | Filter by status (PENDING, ACCEPTED, EXPIRED, REVOKED) |

### POST /api/invitations
Send an invitation.

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "role": "MEMBER"
}
```

**Roles:** ADMIN, MEMBER, VIEWER

**Note:** Only ADMINs can invite ADMIN users.

### POST /api/invitations/bulk
Send multiple invitations.

**Request Body:**
```json
{
  "emails": ["user1@example.com", "user2@example.com"],
  "role": "MEMBER"
}
```

**Limit:** Maximum 20 emails per request.

### GET /api/invitations/verify/:token (Public)
Verify an invitation token.

**Response:**
```json
{
  "valid": true,
  "email": "newuser@example.com",
  "firmName": "Summit Partners",
  "role": "MEMBER",
  "inviter": { "name": "John Doe" }
}
```

### POST /api/invitations/accept/:token (Public)
Accept an invitation and create account.

**Request Body:**
```json
{
  "password": "securePassword123",
  "fullName": "Jane Smith"
}
```

**Password Requirements:** Minimum 8 characters.

### DELETE /api/invitations/:id
Revoke a pending invitation.

### POST /api/invitations/:id/resend
Resend invitation email (extends expiration).

---

## Notifications

### GET /api/notifications
List notifications for current user.

### GET /api/notifications/unread-count
Get unread notification count.

**Response:**
```json
{
  "count": 5
}
```

### PATCH /api/notifications/:id/read
Mark notification as read.

### POST /api/notifications/mark-all-read
Mark all notifications as read.

---

## AI Features

### GET /api/ai/status (Public)
Check AI availability.

**Response:**
```json
{
  "enabled": true,
  "model": "gpt-4-turbo-preview"
}
```

### POST /api/deals/:dealId/chat
AI-powered deal analysis chat.

**Request Body:**
```json
{
  "message": "What are the key risks for this deal?",
  "conversationId": "optional-conversation-uuid"
}
```

**Response:**
```json
{
  "response": "Based on the CIM and financial documents...",
  "conversationId": "conversation-uuid",
  "sources": [
    { "documentId": "doc-uuid", "name": "CIM.pdf" }
  ]
}
```

### GET /api/deals/:dealId/thesis
Generate AI investment thesis.

### GET /api/deals/:dealId/risks
Generate AI risk analysis.

---

## Memos

### GET /api/memos
List investment memos.

### GET /api/memos/:id
Get a memo with all sections.

### POST /api/memos
Create a new memo.

**Request Body:**
```json
{
  "dealId": "deal-uuid",
  "title": "Investment Memo - Apex Logistics",
  "templateId": "template-uuid"
}
```

### PATCH /api/memos/:id
Update a memo.

### POST /api/memos/:id/sections/:sectionId/generate
Generate AI content for a memo section.

---

## Ingest

### POST /api/ingest/url
Ingest a document from URL.

**Request Body:**
```json
{
  "url": "https://example.com/document.pdf",
  "dealId": "deal-uuid",
  "type": "CIM"
}
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Deal not found",
    "requestId": "req-uuid-for-support"
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| UNAUTHORIZED | 401 | Invalid or missing authentication |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| BAD_REQUEST | 400 | Validation error |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Server error |

---

## Rate Limiting

- **Limit:** 100 requests per 15 minutes per IP
- **Headers:** Standard rate limit headers included in responses
- **Exceeded:** Returns 429 with retry information

---

## Webhooks (Coming Soon)

Future support for webhooks on:
- Deal stage changes
- Document uploads
- New activities

---

## SDKs & Examples

### JavaScript/TypeScript
```typescript
const response = await fetch('https://pe-os.onrender.com/api/deals', {
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
});
const deals = await response.json();
```

### cURL
```bash
curl -X GET "https://pe-os.onrender.com/api/deals" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### File Upload
```bash
curl -X POST "https://pe-os.onrender.com/api/deals/DEAL_ID/documents" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@document.pdf" \
  -F "type=CIM"
```
