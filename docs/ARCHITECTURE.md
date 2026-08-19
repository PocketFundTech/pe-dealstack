# Avise Technical Architecture

**For Y Combinator Demo & Technical Review**
**Version:** 1.0

---

## System Overview

Avise is an AI-powered CRM platform for Private Equity firms, enabling deal management, document analysis, and investment memo generation.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Avise Architecture                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │                         Frontend (MPA)                              │    │
│   │   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │    │
│   │   │Dashboard │ │Pipeline  │ │Deal View │ │Data Room │ │Memos    │ │    │
│   │   │(index)   │ │(pipeline)│ │(deal)    │ │(vdr)     │ │(memos)  │ │    │
│   │   └──────────┘ └──────────┘ └──────────┘ └──────────┘ └─────────┘ │    │
│   │                                                                    │    │
│   │   Vanilla JS + TailwindCSS + DaisyUI | No Build Required          │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    │ REST API (JSON)                         │
│                                    ▼                                         │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │                      Backend API (Node.js)                          │    │
│   │                                                                      │    │
│   │   ┌──────────────────────────────────────────────────────────────┐  │    │
│   │   │                     Middleware Layer                          │  │    │
│   │   │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │  │    │
│   │   │  │RequestID│ │Rate     │ │Auth     │ │Error    │ │CORS    │ │  │    │
│   │   │  │         │ │Limiter  │ │(JWT)    │ │Handler  │ │        │ │  │    │
│   │   │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └────────┘ │  │    │
│   │   └──────────────────────────────────────────────────────────────┘  │    │
│   │                                                                      │    │
│   │   ┌──────────────────────────────────────────────────────────────┐  │    │
│   │   │                      Route Layer                              │  │    │
│   │   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐ │  │    │
│   │   │  │Deals   │ │Docs    │ │Users   │ │Memos   │ │Invitations │ │  │    │
│   │   │  │        │ │        │ │        │ │        │ │            │ │  │    │
│   │   │  └────────┘ └────────┘ └────────┘ └────────┘ └────────────┘ │  │    │
│   │   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                │  │    │
│   │   │  │Companies││Activities││Folders │ │Chat    │                │  │    │
│   │   │  └────────┘ └────────┘ └────────┘ └────────┘                │  │    │
│   │   └──────────────────────────────────────────────────────────────┘  │    │
│   │                                                                      │    │
│   │   ┌──────────────────────────────────────────────────────────────┐  │    │
│   │   │                     Services Layer                            │  │    │
│   │   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐ │  │    │
│   │   │  │RAG     │ │AI      │ │File    │ │Audit   │ │Notification│ │  │    │
│   │   │  │Engine  │ │Extract │ │Validate│ │Log     │ │Service     │ │  │    │
│   │   │  └────────┘ └────────┘ └────────┘ └────────┘ └────────────┘ │  │    │
│   │   └──────────────────────────────────────────────────────────────┘  │    │
│   │                                                                      │    │
│   │   Express 4.x + TypeScript | Pino Logger | Zod Validation           │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                          │                    │                              │
│             ┌────────────┴────────┐          │                              │
│             │                     │          │                              │
│             ▼                     ▼          ▼                              │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐    │
│   │    Supabase     │  │   Supabase      │  │       OpenAI API        │    │
│   │   PostgreSQL    │  │   Storage       │  │                         │    │
│   │                 │  │                 │  │  ┌───────────────────┐  │    │
│   │  ┌───────────┐  │  │  ┌───────────┐  │  │  │  GPT-4 Turbo     │  │    │
│   │  │ Users     │  │  │  │ Documents │  │  │  │  - Deal Chat     │  │    │
│   │  │ Deals     │  │  │  │ PDFs      │  │  │  │  - Thesis Gen    │  │    │
│   │  │ Companies │  │  │  │ Excels    │  │  │  │  - Risk Analysis │  │    │
│   │  │ Documents │  │  │  │ Images    │  │  │  │  - Memo Sections │  │    │
│   │  │ Activities│  │  │  └───────────┘  │  │  └───────────────────┘  │    │
│   │  │ Memos     │  │  │                 │  │                         │    │
│   │  │ Embeddings│  │  │  100MB/file max │  │  ┌───────────────────┐  │    │
│   │  └───────────┘  │  │                 │  │  │  Embeddings       │  │    │
│   │                 │  │                 │  │  │  ada-002          │  │    │
│   │  RLS Policies   │  │  Public/Private │  │  │  - Doc Chunks     │  │    │
│   │  + Auth         │  │  Buckets        │  │  │  - Semantic Search│  │    │
│   └─────────────────┘  └─────────────────┘  │  └───────────────────┘  │    │
│                                              └─────────────────────────┘    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### Frontend

| Layer | Technology | Purpose |
|-------|------------|---------|
| **UI Framework** | Vanilla JavaScript | No build step, fast iteration |
| **Styling** | TailwindCSS + DaisyUI | Consistent design system |
| **Architecture** | Multi-Page Application | Simple routing, SEO-friendly |
| **Auth** | Supabase Auth | JWT tokens, session management |
| **State** | LocalStorage | Minimal client-side state |

### Backend

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Runtime** | Node.js 20 | Modern JS runtime |
| **Framework** | Express 4.x | Minimal, flexible routing |
| **Language** | TypeScript | Type safety, better DX |
| **Validation** | Zod | Schema-based input validation |
| **Logging** | Pino | High-performance structured logs |
| **Testing** | Vitest | Fast unit & integration tests |

### Data Layer

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Database** | PostgreSQL (Supabase) | ACID-compliant relational DB |
| **ORM** | Direct SQL via Supabase | Simple queries, no ORM overhead |
| **File Storage** | Supabase Storage | S3-compatible object storage |
| **Auth** | Supabase Auth | JWT, OAuth, magic links |
| **Embeddings** | PostgreSQL + pgvector | Vector similarity search |

### AI/ML

| Layer | Technology | Purpose |
|-------|------------|---------|
| **LLM** | OpenAI GPT-4 Turbo | Deal analysis, memo generation |
| **Embeddings** | OpenAI ada-002 | Document vectorization |
| **RAG** | Custom implementation | Context-aware AI responses |
| **Extraction** | GPT-4 + PDF Parse | Document data extraction |

### Infrastructure

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Hosting** | Render.com | Simple PaaS deployment |
| **CDN** | Render (built-in) | Static asset delivery |
| **SSL/TLS** | Automatic (Let's Encrypt) | HTTPS everywhere |
| **Monitoring** | Render Metrics | Basic observability |

---

## Data Model

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    User     │────▶│    Deal     │────▶│   Company   │
├─────────────┤     ├─────────────┤     ├─────────────┤
│ id          │     │ id          │     │ id          │
│ email       │     │ name        │     │ name        │
│ name        │     │ stage       │     │ industry    │
│ firmName    │     │ status      │     │ website     │
│ role        │     │ industry    │     │ description │
│ avatar      │     │ dealSize    │     │ createdAt   │
│ aiPrefs     │     │ revenue     │     └─────────────┘
└─────────────┘     │ ebitda      │
       │            │ companyId   │
       │            │ firmName    │
       ▼            └─────────────┘
┌─────────────┐            │
│ Invitation  │            │
├─────────────┤            ▼
│ id          │     ┌─────────────┐     ┌─────────────┐
│ email       │     │  Document   │     │   Folder    │
│ token       │     ├─────────────┤     ├─────────────┤
│ role        │     │ id          │     │ id          │
│ status      │     │ name        │     │ name        │
│ expiresAt   │     │ type        │     │ dealId      │
│ firmName    │     │ fileUrl     │     │ parentId    │
└─────────────┘     │ extractedText│    └─────────────┘
                    │ embeddings   │
                    │ dealId      │
                    │ folderId    │
                    └─────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Activity   │     │    Memo     │     │Notification │
├─────────────┤     ├─────────────┤     ├─────────────┤
│ id          │     │ id          │     │ id          │
│ type        │     │ title       │     │ title       │
│ title       │     │ status      │     │ message     │
│ description │     │ dealId      │     │ isRead      │
│ dealId      │     │ sections[]  │     │ userId      │
│ userId      │     │ userId      │     │ type        │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## AI Architecture (RAG System)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Document Processing Pipeline                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. UPLOAD          2. EXTRACT          3. CHUNK          4. EMBED   │
│  ┌─────────┐       ┌─────────┐        ┌─────────┐       ┌─────────┐ │
│  │  PDF    │──────▶│  Text   │───────▶│  Split  │──────▶│ Vector  │ │
│  │  XLSX   │       │  Parse  │        │  ~500   │       │ ada-002 │ │
│  │  DOCX   │       │         │        │  tokens │       │         │ │
│  └─────────┘       └─────────┘        └─────────┘       └─────────┘ │
│                                                               │      │
│                                                               ▼      │
│                                                        ┌──────────┐  │
│                                                        │PostgreSQL│  │
│                                                        │ pgvector │  │
│                                                        └──────────┘  │
│                                                               │      │
└───────────────────────────────────────────────────────────────┼──────┘
                                                                │
┌───────────────────────────────────────────────────────────────┼──────┐
│                    Query Processing (RAG)                     │      │
├───────────────────────────────────────────────────────────────┼──────┤
│                                                               │      │
│  1. QUERY           2. EMBED           3. SEARCH        4. GENERATE │
│  ┌─────────┐       ┌─────────┐       ┌─────────┐       ┌─────────┐ │
│  │"What are│──────▶│ Vector  │──────▶│Semantic │──────▶│  GPT-4  │ │
│  │the key  │       │ ada-002 │       │ Search  │       │ + Top K │ │
│  │risks?"  │       │         │       │ pgvector│       │ Context │ │
│  └─────────┘       └─────────┘       └─────────┘       └─────────┘ │
│                                            │                  │      │
│                                            │                  │      │
│                                    ┌───────┴───────┐          │      │
│                                    │ Top 5 Chunks  │──────────┘      │
│                                    │ (by cosine    │                 │
│                                    │  similarity)  │                 │
│                                    └───────────────┘                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Request Flow

```
User Request
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Rate Limiter (100 req/15min)                                    │
├─────────────────────────────────────────────────────────────────────┤
│  2. Request ID Middleware (UUID for correlation)                    │
├─────────────────────────────────────────────────────────────────────┤
│  3. Auth Middleware                                                 │
│     - Extract Bearer token                                          │
│     - Validate JWT via Supabase                                     │
│     - Attach user to request                                        │
├─────────────────────────────────────────────────────────────────────┤
│  4. Route Handler                                                   │
│     - Zod schema validation                                         │
│     - Business logic                                                │
│     - Database queries (with firmName filter)                       │
├─────────────────────────────────────────────────────────────────────┤
│  5. Response                                                        │
│     - JSON serialization                                            │
│     - Error standardization                                         │
│     - Audit logging (for mutations)                                 │
└─────────────────────────────────────────────────────────────────────┘
     │
     ▼
JSON Response
```

---

## Deployment Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         GitHub Repository                           │
│                              (main)                                 │
└────────────────────────────────────────────────────────────────────┘
                                │
                                │ Push / Merge
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Render.com                                  │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Build Phase:                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  npm install                                                  │  │
│  │  npm run build (tsc compile)                                 │  │
│  │  Copy static assets                                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Runtime:                                                           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Node.js 20                                                   │  │
│  │  npm run start                                               │  │
│  │  PORT=3001 (auto-assigned)                                   │  │
│  │  Health check: /health                                       │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Features:                                                          │
│  ├── Auto-scaling (Pro tier)                                       │
│  ├── Zero-downtime deploys                                         │
│  ├── Automatic HTTPS                                               │
│  └── Built-in CDN                                                  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
       │  Supabase   │   │  Supabase   │   │   OpenAI    │
       │  Database   │   │  Storage    │   │    API      │
       │  (US East)  │   │  (US East)  │   │  (Global)   │
       └─────────────┘   └─────────────┘   └─────────────┘
```

---

## Key Technical Decisions

### Why No Framework (Vanilla JS Frontend)?

1. **Faster iteration** - No build step, instant reload
2. **Simpler debugging** - No virtual DOM, direct DOM manipulation
3. **Lower learning curve** - Standard JavaScript
4. **Performance** - Smaller bundle, faster initial load
5. **PE firms expect reliability** - Less moving parts

### Why Express (Not Fastify/Hono)?

1. **Mature ecosystem** - Most middleware available
2. **Team familiarity** - Widely known
3. **Good enough performance** - Not CPU-bound
4. **Easy to migrate later** - Standard patterns

### Why Supabase (Not Firebase/AWS)?

1. **PostgreSQL** - Proper relational database
2. **Row Level Security** - Built-in multi-tenancy
3. **pgvector** - Native vector search for RAG
4. **Open source** - No vendor lock-in
5. **Generous free tier** - Good for startups

### Why OpenAI GPT-4 (Not Claude/Gemini)?

1. **Best-in-class reasoning** - Complex financial analysis
2. **Reliable API** - Production-grade uptime
3. **Embeddings + Chat** - Single provider
4. **Can switch later** - Abstracted behind service layer

---

## Scalability Considerations

### Current Limits

| Resource | Current | Scalable To |
|----------|---------|-------------|
| Concurrent Users | ~100 | ~10,000 (with upgrades) |
| Database | 500MB | Unlimited (Supabase Pro) |
| File Storage | 1GB | Unlimited |
| API Requests | 100/15min/IP | Configurable |
| Document Size | 100MB | Configurable |

### Scaling Path

1. **Vertical** - Upgrade Render instance (current: Starter)
2. **Horizontal** - Multiple instances + load balancer (Render Pro)
3. **Database** - Supabase Pro with read replicas
4. **CDN** - Cloudflare for static assets
5. **Background Jobs** - Redis + BullMQ for long tasks

---

## Future Architecture (Post-PMF)

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Future Considerations                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │  React/Next.js  │  │  Background     │  │  Real-time      │      │
│  │  Frontend       │  │  Job Queue      │  │  (WebSockets)   │      │
│  │  (if needed)    │  │  (Redis/BullMQ) │  │                 │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘      │
│                                                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │  Microservices  │  │  Event-Driven   │  │  Analytics      │      │
│  │  (if needed)    │  │  Architecture   │  │  (Mixpanel)     │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘      │
│                                                                       │
│  Note: Keep it simple until we have 100+ paying customers            │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Technical Contact

For architecture questions during YC interview:
- Explain the monolith-first approach
- Emphasize RAG as the technical moat
- Show test coverage and security measures
- Discuss scalability path when asked

---

*Architecture designed for speed of iteration, not premature optimization.*
*"Make it work, make it right, make it fast" - in that order.*
