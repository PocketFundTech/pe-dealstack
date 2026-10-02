import { Fragment } from "react";
import { ENDPOINT_INDEX, ENDPOINT_TOTAL } from "./endpoint-index";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Endpoint = {
  method: Method;
  path: string;
  description: React.ReactNode;
  queryParams?: string;
  body?: string;
};

type EndpointGroup = {
  title: string;
  blurb: string;
  iconKey: string;
  iconWrapClass: string;
  defaultOpen?: boolean;
  endpoints: Endpoint[];
};

const METHOD_CLASS: Record<Method, string> = {
  GET: "bg-emerald-100 text-emerald-800",
  POST: "bg-blue-100 text-blue-800",
  PUT: "bg-amber-100 text-amber-800",
  PATCH: "bg-amber-100 text-amber-800",
  DELETE: "bg-rose-100 text-rose-800",
};

const code = "bg-[#f1f5f9] px-1 rounded text-xs";

const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    title: "Deals",
    blurb: "Create, read, update and delete deals in your pipeline",
    iconKey: "handshake",
    iconWrapClass: "bg-blue-500/10 text-blue-600",
    defaultOpen: true,
    endpoints: [
      {
        method: "GET",
        path: "/api/deals",
        description:
          "List your organization's deals (plain array, newest activity first). Deleted deals are excluded.",
        queryParams:
          "updatedSince (ISO date: only deals changed since), limit (≤500), offset, stage, status, industry, priority, assignedTo, minDealSize, maxDealSize, search, sortBy, sortOrder",
      },
      {
        method: "GET",
        path: "/api/deals/:id",
        description:
          "One deal with its company, team, documents, activities and folders. 404 if it isn't in your organization.",
      },
      {
        method: "POST",
        path: "/api/deals",
        description: (
          <>
            Create a deal. <strong>name</strong> and <strong>companyName</strong> (or{" "}
            <code className={code}>companyId</code>) are required. Stages: INITIAL_REVIEW (default),
            DUE_DILIGENCE, IOI_SUBMITTED, LOI_SUBMITTED, NEGOTIATION, CLOSING, PASSED, CLOSED_WON,
            CLOSED_LOST. Priority: LOW, MEDIUM, HIGH, URGENT.
          </>
        ),
        body: `{
  "name": "Project Falcon",
  "companyName": "Falcon Logistics",
  "industry": "Logistics",
  "stage": "INITIAL_REVIEW",
  "revenue": 42.5,
  "ebitda": 6.1,
  "dealSize": 120,
  "priority": "HIGH",
  "source": "n8n",
  "tags": ["inbound"]
}`,
      },
      {
        method: "PATCH",
        path: "/api/deals/:id",
        description: (
          <>
            Update any deal field. Add <code className={code}>stageNote</code> to record why a stage
            changed. Send <code className={code}>lastKnownUpdatedAt</code> to get a 409 instead of
            overwriting someone else&apos;s newer edit.
          </>
        ),
        body: '{ "stage": "DUE_DILIGENCE", "stageNote": "Management call went well" }',
      },
      {
        method: "DELETE",
        path: "/api/deals/:id",
        description: "Move a deal to trash (204). Restore it with POST /api/deals/:id/restore.",
      },
      {
        method: "GET",
        path: "/api/deals/stats/summary",
        description: "Pipeline counts: total, active, passed and deals per stage.",
      },
    ],
  },
  {
    title: "Contacts & Companies",
    blurb: "Bankers, advisors, executives and the companies behind your deals",
    iconKey: "contacts",
    iconWrapClass: "bg-sky-500/10 text-sky-600",
    endpoints: [
      {
        method: "GET",
        path: "/api/contacts",
        description: "Paged contact list: { contacts, total, limit, offset }. limit up to 200.",
        queryParams: "updatedSince, search, type, company, tag, sortBy, sortOrder, limit, offset",
      },
      {
        method: "POST",
        path: "/api/contacts",
        description: (
          <>
            Create a contact. <strong>firstName</strong> and <strong>lastName</strong> are required.
            Type: BANKER, ADVISOR, EXECUTIVE, LP, LEGAL, OTHER. A duplicate email returns 409 with{" "}
            <code className={code}>existingContactId</code>.
          </>
        ),
        body: `{
  "firstName": "Priya",
  "lastName": "Shah",
  "email": "priya@bank.com",
  "company": "Example Bank",
  "type": "BANKER",
  "tags": ["mid-market"]
}`,
      },
      {
        method: "PATCH",
        path: "/api/contacts/:id",
        description: "Update any contact field. DELETE on the same path removes the contact.",
      },
      {
        method: "POST",
        path: "/api/contacts/import",
        description: "Bulk create up to 500 contacts in one call.",
        body: '{ "contacts": [ { "firstName": "…", "lastName": "…", "email": "…" } ] }',
      },
      {
        method: "POST",
        path: "/api/contacts/:id/deals",
        description: "Link a contact to a deal.",
      },
      {
        method: "GET",
        path: "/api/companies",
        description: "Companies with their deals. POST with { name, industry, website } creates one.",
        queryParams: "updatedSince, limit (≤500), offset",
      },
    ],
  },
  {
    title: "Tasks & Notes",
    blurb: "Follow-ups, to-dos and the activity feed on each deal",
    iconKey: "task_alt",
    iconWrapClass: "bg-teal-500/10 text-teal-600",
    endpoints: [
      {
        method: "GET",
        path: "/api/tasks",
        description: "Paged tasks: { tasks, count, limit, offset }.",
        queryParams: "updatedSince, status, priority, assignedTo, dealId, limit, offset",
      },
      {
        method: "GET",
        path: "/api/tasks/:id",
        description: "One task with its assignee and deal.",
      },
      {
        method: "POST",
        path: "/api/tasks",
        description:
          "Create a task. title is required. Status: PENDING, IN_PROGRESS, COMPLETED, STUCK.",
        body: '{ "title": "Request Q3 management accounts", "dealId": "uuid", "priority": "HIGH", "dueDate": "2026-10-15" }',
      },
      {
        method: "POST",
        path: "/api/deals/:dealId/activities",
        description: (
          <>
            Add a note or log activity on a deal. <strong>type</strong> and <strong>title</strong> are
            required. Use NOTE_ADDED for notes; also CALL_LOGGED, MEETING_SCHEDULED, EMAIL_SENT.
            Emails in <code className={code}>mentionedEmails</code> notify those teammates.
          </>
        ),
        body: '{ "type": "NOTE_ADDED", "title": "Banker call", "description": "Seller wants to close by Q1." }',
      },
      {
        method: "GET",
        path: "/api/deals/:dealId/activities",
        description: "A deal's activity feed, newest first: { data, total, limit, offset }.",
      },
    ],
  },
  {
    title: "Documents",
    blurb: "Upload files to a deal's data room",
    iconKey: "folder_open",
    iconWrapClass: "bg-orange-500/10 text-orange-600",
    endpoints: [
      {
        method: "GET",
        path: "/api/deals/:dealId/documents",
        description: "A deal's documents.",
        queryParams: "type, folderId, tags, search",
      },
      {
        method: "POST",
        path: "/api/deals/:dealId/documents",
        description:
          "Upload one file as multipart form data in the field named file (PDF, Excel, CSV, Word, .msg, .eml, JPG, PNG). Up to 4.5 MB this way; use the signed upload below for larger files. Avise reads the file with AI after responding.",
        body: `Content-Type: multipart/form-data
file: (binary)    name: optional    type: CIM | TEASER | FINANCIALS | LEGAL | NDA | OTHER`,
      },
      {
        method: "POST",
        path: "/api/uploads/sign",
        description:
          "For files over 4.5 MB: get a signed URL, PUT the bytes to it, then call the upload or ingest endpoint with { storagePath, fileName, mimeType, size }.",
        body: '{ "fileName": "CIM.pdf", "contentType": "application/pdf", "size": 18200000, "purpose": "data-room", "dealId": "uuid" }',
      },
      {
        method: "GET",
        path: "/api/documents/:id/download",
        description: "Download a document. PATCH and DELETE on /api/documents/:id rename or remove it.",
      },
    ],
  },
  {
    title: "Deal Ingestion (AI)",
    blurb: "Create or update deals from files, text, URLs or emails",
    iconKey: "upload_file",
    iconWrapClass: "bg-violet-500/10 text-violet-600",
    endpoints: [
      {
        method: "POST",
        path: "/api/ingest/text",
        description:
          "Create a deal from pasted text such as a banker email (50 characters or more). Pass dealId to update an existing deal instead.",
        body: `{
  "text": "Deal content text...",
  "sourceType": "email",            // email | note | slack | whatsapp | other
  "sourceName": "Inbound from banker"
}`,
      },
      {
        method: "POST",
        path: "/api/ingest/url",
        description: "Research a company from its website and create a deal.",
        body: `{
  "url": "https://acme.com",
  "companyName": "Acme Corp",       // optional override
  "autoCreateDeal": true            // false = preview only
}`,
      },
      {
        method: "POST",
        path: "/api/ingest",
        description:
          "Create a deal from a CIM, teaser or financials file (multipart, field file). Optional dealId, source.",
        body: `Content-Type: multipart/form-data
Body: file (binary)`,
      },
      {
        method: "POST",
        path: "/api/ingest/email",
        description: "Upload a .eml email file; its body and PDF attachments are read.",
        body: `Content-Type: multipart/form-data
Body: file (.eml)`,
      },
      {
        method: "POST",
        path: "/api/ingest/bulk",
        description: "Bulk import deals from Excel or CSV, one deal per row.",
      },
    ],
  },
  {
    title: "Memos (AI)",
    blurb: "Investment memos generated from a deal's documents",
    iconKey: "description",
    iconWrapClass: "bg-emerald-500/10 text-emerald-600",
    endpoints: [
      {
        method: "GET",
        path: "/api/memos",
        description: "List memos.",
        queryParams: "dealId, status, type, limit, offset",
      },
      {
        method: "POST",
        path: "/api/memos",
        description: "Create a memo for a deal. title and dealId are required.",
        body: `{
  "dealId": "uuid",
  "title": "Investment Memo - Acme Corp",
  "type": "IC_MEMO",          // IC_MEMO | TEASER | SUMMARY | CUSTOM
  "templateId": "uuid"        // optional
}`,
      },
      {
        method: "POST",
        path: "/api/memos/:id/generate-all",
        description: "Generate every section of a memo with AI.",
      },
      {
        method: "POST",
        path: "/api/memos/:id/sections/:sectionId/generate",
        description: "Regenerate a single memo section.",
      },
    ],
  },
  {
    title: "Export, Audit & Account",
    blurb: "Exports, audit trail and the identity behind your key",
    iconKey: "download",
    iconWrapClass: "bg-amber-500/10 text-amber-600",
    endpoints: [
      {
        method: "GET",
        path: "/api/users/me",
        description:
          "The user the key acts as, with their organization. Use it as a connection test.",
      },
      {
        method: "GET",
        path: "/api/users/me/team",
        description: "Everyone in your organization.",
      },
      {
        method: "GET",
        path: "/api/export/deals?format=csv",
        description: "Export deals as csv or json (default json).",
        queryParams: "format, stage, status, industry",
      },
      {
        method: "GET",
        path: "/api/audit",
        description: "Audit log entries, paged.",
        queryParams:
          "action, resourceType, resourceId, severity, startDate, endDate, limit, offset",
      },
    ],
  },
];

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div className="p-4 rounded-lg bg-white border border-[#e2e8f0]">
      <div className="flex items-center gap-3 mb-3">
        <span
          className={`px-2 py-0.5 rounded text-xs font-bold font-mono ${METHOD_CLASS[endpoint.method]}`}
        >
          {endpoint.method}
        </span>
        <code className="text-sm font-mono text-[#111418]">{endpoint.path}</code>
      </div>
      <p className="text-sm text-[#64748b]">{endpoint.description}</p>
      {endpoint.queryParams && (
        <div className="text-xs font-mono text-[#64748b] mt-2">
          <span className="font-semibold text-[#111418]">Query params:</span>
          <span className="ml-2">{endpoint.queryParams}</span>
        </div>
      )}
      {endpoint.body && (
        <pre className="bg-[#1e293b] rounded-lg p-3 overflow-x-auto text-xs mt-3">
          <code className="text-gray-300 font-mono whitespace-pre">{endpoint.body}</code>
        </pre>
      )}
    </div>
  );
}

export function EndpointSections() {
  return (
    <div className="space-y-4">
      {ENDPOINT_GROUPS.map((group) => (
        <details
          key={group.title}
          className="group rounded-xl bg-[#f8fafc] border border-[#e2e8f0] overflow-hidden"
          open={group.defaultOpen}
        >
          <summary className="flex items-center gap-4 p-6 cursor-pointer list-none">
            <div
              className={`size-10 rounded-lg flex items-center justify-center flex-shrink-0 ${group.iconWrapClass}`}
            >
              <span className="material-symbols-outlined">{group.iconKey}</span>
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-[#111418]">{group.title}</h3>
              <p className="text-sm text-[#64748b]">{group.blurb}</p>
            </div>
            <span className="material-symbols-outlined text-[#64748b] group-open:rotate-180 transition-transform">
              expand_more
            </span>
          </summary>
          <div className="px-6 pb-6 pt-2 border-t border-[#e2e8f0]">
            <div className="space-y-4">
              {group.endpoints.map((ep, idx) => (
                <Fragment key={`${ep.method}-${ep.path}-${idx}`}>
                  <EndpointCard endpoint={ep} />
                </Fragment>
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

export function FullEndpointIndex() {
  return (
    <div className="space-y-3">
      {ENDPOINT_INDEX.map((group) => (
        <details
          key={group.title}
          className="group rounded-xl bg-white border border-[#e2e8f0] overflow-hidden"
        >
          <summary className="flex items-center gap-3 px-5 py-4 cursor-pointer list-none">
            <h3 className="flex-1 font-semibold text-[#111418]">{group.title}</h3>
            <span className="text-xs text-[#64748b]">{group.endpoints.length}</span>
            <span className="material-symbols-outlined text-[#64748b] group-open:rotate-180 transition-transform">
              expand_more
            </span>
          </summary>
          <div className="px-5 pb-4 border-t border-[#e2e8f0]">
            {group.note && <p className="text-xs text-[#64748b] pt-3">{group.note}</p>}
            <ul className="pt-2 divide-y divide-[#f1f5f9]">
              {group.endpoints.map(([method, path]) => (
                <li key={`${method} ${path}`} className="flex items-center gap-3 py-1.5">
                  <span
                    className={`w-16 shrink-0 text-center px-2 py-0.5 rounded text-[11px] font-bold font-mono ${METHOD_CLASS[method]}`}
                  >
                    {method}
                  </span>
                  <code className="text-[13px] font-mono text-[#111418] break-all">{path}</code>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ))}
      <p className="text-xs text-[#64748b]">{ENDPOINT_TOTAL} endpoints in total.</p>
    </div>
  );
}
