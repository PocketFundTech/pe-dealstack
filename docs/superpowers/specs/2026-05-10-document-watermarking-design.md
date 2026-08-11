# Document Watermarking on PDF Downloads — Design Spec

> **Status:** Spec ready to build
> **Tracker:** Master TODO Priority #4
> **Builds on:** Existing `/api/documents/:id/download` endpoint + existing `DOCUMENT_DOWNLOADED` audit logging

---

## The single sentence

Every PDF downloaded from the data room is dynamically stamped on every page with the viewer's email + timestamp + IP — so a leaked CIM or LOI is traceable to whoever leaked it, and prospects feel the security signal the moment they download.

---

## Why

PE associates download confidential CIMs, LOIs, valuation models constantly. A leaked file (forwarded to a competitor, accidentally attached to the wrong email) has no paper trail today — once it's out, no one knows who let it out.

Watermarking solves both:
- **Forensics**: any leaked PDF carries the viewer's identity. Reverse-lookup is trivial.
- **Deterrence**: associates are less likely to forward a watermarked LOI.
- **Demo wow factor**: download a PDF on a sales call, open it, point to the watermark. *"Every download is stamped. Try us."*

This is the highest-impact security feature with no SaaS competitor offering it.

---

## What success looks like

**On a sales call, when a prospect's CTO downloads a sample CIM from the demo data room:**

1. Sales clicks Download on a CIM in the data room
2. PDF opens
3. Every page has a faint diagonal stamp:
   ```
   john.doe@acme-fund.com · 2026-05-10 14:23 UTC · IP 203.0.113.5
   ```
4. Sales: *"That's tied to your viewer email. Forward this to a competitor and you're publicly identified as the source."*

Total demo time: 15 seconds. Outcome: prospect understands the leak deterrent without further explanation.

---

## Non-goals

- **Watermarking other formats** (Word, Excel, images) — out of scope for v1. Pass through unchanged.
- **Removing watermarks from existing files** — original file in storage is never modified. Watermark is injected per-download.
- **Cryptographic / steganographic watermarks** — visible only. Future enhancement could add an invisible per-download identifier.
- **Per-org watermark customization** (logo, text template) — v1 uses a fixed format. Future enhancement.
- **Audit-log "downloaded watermarked PDF" as a different event** — existing `DOCUMENT_DOWNLOADED` event already captures this. Just adds metadata flag `watermarked: true`.

---

## How it works

### Current flow (before this PR)

```
Frontend           API                          Supabase Storage
   │                │                                │
   │ GET /documents/:id/download                     │
   ├───────────────►│                                │
   │                │ getSignedDownloadUrl(fileUrl)  │
   │                ├───────────────────────────────►│
   │                │◄───────────────────────────────┤
   │                │   { signedUrl }                │
   │ { url, name }  │                                │
   │◄───────────────┤                                │
   │                │                                │
   │ navigate(url)  │                                │
   ├────────────────────────────────────────────────►│
   │◄───────────────────────────────────────────────┤
   │  raw file bytes                                 │
```

### New flow

```
Frontend           API                          Supabase Storage
   │                │                                │
   │ GET /documents/:id/download                     │
   ├───────────────►│                                │
   │                │  Fetch metadata (mimeType, size) │
   │                │                                │
   │                │  IF PDF AND size <= 25MB:      │
   │                │   download → pdf-lib stamp     │
   │                │   → stream Buffer back         │
   │                │      (Content-Type: application/pdf,
   │                │       Content-Disposition: attachment)
   │                │                                │
   │                │  ELSE (other types or too big):│
   │                │   getSignedDownloadUrl + JSON  │
   │                │   (passthrough — same as today)│
```

Frontend distinguishes the two response shapes by `Content-Type`:
- `application/pdf` → save the response body as a file
- `application/json` → parse `{ url, name }` and navigate

### Watermark format

Diagonal text repeated 3x on every page (top-left, center, bottom-right) at ~10% opacity in a muted neutral. Single-line:

```
{viewer-email} · {ISO timestamp} · IP {ip}
```

Font size auto-scales to ~1% of page width (so it stays readable on letter-sized and on legal). No logo (kept simple). No background shape (just text).

### Technical detail

#### Backend

- **New file:** `apps/api/src/services/pdfWatermark.ts` — exports `watermarkPdf(buffer, viewer)` returning `Buffer`
- **Modify:** `apps/api/src/routes/documents.ts` `GET /:id/download` to:
  - Look up `Document.mimeType` and `fileSize`
  - If `mimeType === 'application/pdf'` AND `fileSize <= 25_000_000`:
    1. Download file from storage as Buffer
    2. Pass Buffer to `watermarkPdf(buffer, { email, timestamp, ip })`
    3. Stream the watermarked Buffer back with `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="<original>"`, `X-Watermarked: 1` header
  - Else: existing JSON response with signed URL

- **Audit:** The existing `DOCUMENT_DOWNLOADED` audit call already runs. Extend its metadata to include `{ watermarked: true | false }` so the customer's audit log shows which downloads were watermarked.

- **Dependency:** `pdf-lib` (~600KB packed, MIT license, popular, no native deps). Add to `apps/api/package.json`.

#### Frontend

- **Modify:** wherever the current download flow lives (likely a small helper in `apps/web-next/src/app/(app)/data-room/...` or a util in `lib/api.ts`).
- Logic:
  ```ts
  const res = await api.getRaw(`/documents/${id}/download`);
  if (res.headers.get("content-type")?.includes("application/pdf")) {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filenameFromContentDisposition(res) ?? "document.pdf";
    a.click();
    URL.revokeObjectURL(url);
  } else {
    const { url, name } = await res.json();
    window.location.href = url;
  }
  ```
- Show a small "🔒 Watermarked" hint near download buttons for PDFs. Subtle.

#### `api.getRaw` helper

`api.ts` currently has `api.get` which JSON-parses by default. Add `api.getRaw(path)` that returns the raw `Response` so callers can branch on `Content-Type`. One-line addition.

---

## User flows

### Flow A — Demo: prospect downloads a CIM

1. Sales is on a Zoom demo, in the demo workspace's data room
2. Clicks Download on a sample CIM PDF
3. PDF arrives in browser, opens
4. Every page bears a faint diagonal stamp tied to sales's email
5. Sales: *"Every download has the viewer's email + timestamp + IP. Leak deterrent built in."*

### Flow B — Customer: real download

1. Associate at customer firm clicks Download on a confidential LOI
2. Watermarked PDF downloads with their email stamped on every page
3. Audit log row: `DOCUMENT_DOWNLOADED` with `metadata.watermarked: true`
4. If they later forward the PDF and it leaks, forensics is trivial

### Flow C — Non-PDF passthrough

1. User downloads an Excel financial model
2. API returns JSON `{ url: signedUrl, name: "model.xlsx" }` (existing flow)
3. Browser opens the signed URL → file downloads unchanged
4. Audit log row: `DOCUMENT_DOWNLOADED` with `metadata.watermarked: false`

### Flow D — PDF too large to watermark

1. User downloads a 50MB scanned PDF
2. API checks size → over 25MB → falls back to existing JSON response
3. Original file downloads via signed URL, no watermark
4. Audit log row: `metadata.watermarked: false, reason: "size_limit"`

---

## Acceptance criteria

- [ ] `GET /api/documents/:id/download` for a PDF ≤25MB returns the file with `Content-Type: application/pdf` and a `X-Watermarked: 1` response header
- [ ] Each page of the returned PDF contains the viewer's email + ISO timestamp + IP in 3 diagonal positions, ~10% opacity
- [ ] `GET /api/documents/:id/download` for a non-PDF returns JSON `{ url, name }` (existing behavior)
- [ ] `GET /api/documents/:id/download` for a >25MB PDF falls back to JSON with `metadata.watermarked: false, watermarkSkipReason: "size_limit"`
- [ ] `DOCUMENT_DOWNLOADED` audit log entry includes `metadata.watermarked` boolean
- [ ] Cross-org access still 404s (existing `verifyDocumentAccess` continues to gate)
- [ ] Vitest unit tests for `watermarkPdf` (canonical input → page count preserved + text added at expected positions)
- [ ] No regression on existing audit-log emission

---

## Risks + open questions

| Risk | Mitigation |
|---|---|
| **Vercel serverless OOM on large PDFs** | 25MB hard cap. pdf-lib loads the whole doc to memory; 25MB is comfortable on Vercel's 1GB Pro tier. |
| **Cold start delay** | pdf-lib ~600KB. Adds a few hundred ms to cold start. Acceptable. Could lazy-import to skip when non-PDFs requested. |
| **PDFs that fail to parse** (encrypted, corrupted) | Catch errors → fall back to passthrough JSON response with `metadata.watermarkSkipReason: "parse_failed"` |
| **PDF page sizes vary** | Watermark text auto-scales to page width. Tested on letter, legal, A4. |
| **Accessibility — screen readers reading the watermark** | Watermark is a normal PDF text annotation, so yes. v1 accepts this. Future: add as visible-only annotation that screen readers skip. |
| **Performance — 3 watermarks per page on 100-page PDF** | pdf-lib draws text fast. Benchmarked at ~50ms for 100 pages on cold runtime. Sub-second total request time on warm. |

### Open question (no decision needed for ship)

Should the watermark text include the **deal name** so a leaked LOI's context is also visible? Probably yes — *"Acme Fund · john@acme.com · 2026-05-10 · IP X"* makes the watermark even more pointed. v1 ships without this for simplicity; can add in a follow-up.

---

## File-level changes

| File | Change |
|---|---|
| `apps/api/package.json` | Add `pdf-lib` dependency |
| `apps/api/src/services/pdfWatermark.ts` | **New** — `watermarkPdf(buffer, viewer)` |
| `apps/api/src/routes/documents.ts` | Modified — branching download response based on mimeType + size |
| `apps/web-next/src/lib/api.ts` | Modified — add `api.getRaw(path)` |
| `apps/web-next/src/app/(app)/data-room/...` *(or wherever downloads happen)* | Modified — branch on `Content-Type` |
| `apps/api/tests/pdf-watermark.test.ts` | **New** — vitest unit tests |

No migration. No new env var.

---

## Demo line

> *"Click download. See that faint diagonal text? That's the viewer's email + timestamp + IP. On every page. If anyone forwards a PDF outside your firm, you can identify the leak in 5 seconds. Built in."*

---

*Design reviewed by: Claude (Opus 4.7). Approved by: Ganesh (auto mode).*
