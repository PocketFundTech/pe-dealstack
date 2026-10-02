import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";
import { EndpointSections, FullEndpointIndex } from "./sections";
import { ENDPOINT_TOTAL } from "./endpoint-index";

export const metadata: Metadata = {
  title: "API Reference - Avise",
  description:
    "Avise REST API reference. Connect n8n, Zapier, Make or your own scripts with an API key: deals, contacts, tasks, documents, ingestion, memos, export and audit.",
};

const RATE_LIMITS = [
  {
    tier: "General",
    limit: "600 requests",
    window: "15 minutes",
    applies: "Every endpoint, counted per API key",
  },
  {
    tier: "Ingestion",
    limit: "30 requests",
    window: "1 minute",
    applies: "/api/ingest/… (on top of the general limit)",
  },
  {
    tier: "AI",
    limit: "10 requests",
    window: "1 minute",
    applies: "/api/ai/…, deal and memo chat, memo section generation, financial extraction",
  },
];

const KEY_RULES = [
  ["Format", "avise_sk_ followed by 43 letters, digits, - or _"],
  ["Header", "Authorization: Bearer avise_sk_… (or X-API-Key: avise_sk_…)"],
  ["Acts as", "The admin who created it, inside their organization only"],
  ["Access", "Full (read + write) or read-only, chosen at creation"],
  ["Can reach", "Every endpoint below, with that admin's permissions — read-only keys refuse any non-GET request"],
  ["Cannot do", "Create, list or revoke API keys (sign in to Avise for that)"],
  ["Expiry", "Never, 30 days, 90 days or 1 year, chosen at creation"],
  ["Shown", "Once, at creation. Avise stores only a fingerprint of it"],
  ["Stops working", "When revoked or expired, or when its creator is deactivated or leaves the organization"],
];

const ERRORS = [
  ["400", "A field is missing or invalid", "Read details in the response and fix the body"],
  ["401", "API key wrong, revoked or expired", "Create a new key in Settings → API Keys"],
  ["403", "The key's owner lacks permission, MFA_REQUIRED, or API_KEY_READ_ONLY", "Use an admin's key, the owner sets up 2FA, or use a full-access key for writes"],
  ["404", "Record not found in your organization", "Check the id"],
  ["409", "Duplicate contact email, or the deal changed since you read it", "Use existingContactId, or re-read and retry"],
  ["413", "Request body over 4.5 MB", "Use the signed upload (POST /api/uploads/sign)"],
  ["429", "Rate limit reached", "Wait until the RateLimit-Reset header says"],
  ["503", "AI provider unavailable (AI endpoints only)", "Retry later"],
];

const WEBHOOK_EVENTS = [
  ["deal.created", "A deal is created in the app, by the API, or from ingest (file, text, URL, email)"],
  ["deal.updated", "Any deal field changes"],
  ["deal.stage_changed", "A deal moves stage; data includes previousStage"],
  ["deal.deleted", "A deal is moved to trash"],
  ["contact.created / contact.updated / contact.deleted", "Contact changes"],
  ["task.created / task.updated", "Task changes"],
  ["task.completed", "A task's status becomes COMPLETED"],
  ["document.uploaded", "A file is added to a deal's data room"],
];

const pre = "bg-[#1e293b] rounded-lg p-4 overflow-x-auto";
const preCode = "text-gray-300 font-mono text-[13px] leading-relaxed whitespace-pre";
const th = "text-left py-3 px-4 font-semibold text-[#111418]";

export default function ApiReferencePage() {
  return (
    <MarketingPageShell active="resources">
      {/* Hero */}
      <div className="bg-gradient-to-br from-emerald-500/5 to-green-50 py-20">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <nav className="flex items-center justify-center gap-2 text-sm text-[#64748b] mb-6">
            <Link href="/resources" className="hover:text-primary transition-colors">
              Resources
            </Link>
            <span className="material-symbols-outlined text-base">chevron_right</span>
            <span className="text-[#111418] font-medium">API Reference</span>
          </nav>
          <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-6">
            API Reference
          </h1>
          <p className="text-lg text-[#64748b] max-w-3xl mx-auto mb-8">
            Connect n8n, Zapier, Make or your own scripts to Avise. Create an API
            key in Settings and send it as a Bearer token.
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-[#e2e8f0] font-mono text-sm">
            <span className="text-[#64748b]">Base URL:</span>
            <span className="text-primary font-semibold">
              https://app.avise.io/api
            </span>
          </div>
        </div>
      </div>

      {/* Authentication */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="flex items-center gap-3 mb-6">
          <div className="size-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-600">
            <span className="material-symbols-outlined">key</span>
          </div>
          <h2 className="text-2xl font-bold text-[#111418]">Authentication: API keys</h2>
        </div>
        <div className="p-6 rounded-xl bg-white border border-[#e2e8f0] shadow-sm mb-6">
          <p className="text-[#64748b] mb-4">
            An organization admin creates keys in{" "}
            <strong className="text-[#111418]">Settings → API Keys</strong>. Name each key after
            where it will live (for example &ldquo;n8n — deal intake&rdquo;), choose{" "}
            <strong className="text-[#111418]">Full access</strong> or{" "}
            <strong className="text-[#111418]">Read-only</strong> (a read-only key can GET data but any
            write request gets a 403), pick an expiry, and copy it when it is shown: it is never shown
            again. Send it on every request:
          </p>
          <pre className={pre}>
            <code className={preCode}>{`Authorization: Bearer avise_sk_YOUR_KEY

# Test a key
curl -H "Authorization: Bearer avise_sk_YOUR_KEY" https://app.avise.io/api/users/me`}</code>
          </pre>
        </div>
        <div className="rounded-xl border border-[#e2e8f0] bg-white overflow-x-auto mb-6">
          <table className="w-full text-sm border-collapse">
            <tbody className="text-[#64748b]">
              {KEY_RULES.map(([rule, value], idx) => (
                <tr key={rule} className={idx < KEY_RULES.length - 1 ? "border-b border-[#e2e8f0]" : ""}>
                  <td className="py-3 px-4 font-medium text-[#111418] w-40 align-top">{rule}</td>
                  <td className="py-3 px-4">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <strong>Keep keys secret.</strong> A key is as powerful as the admin who created it. Store it
          only in your tool&apos;s credential store, use one key per integration, and revoke it in
          Settings the moment it may have leaked. It stops working on the next request.
        </div>
      </div>

      {/* n8n */}
      <div className="bg-white py-16">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl font-bold text-[#111418] mb-6">Connect n8n, Zapier or Make</h2>
          <ol className="list-decimal pl-6 space-y-2 text-[#64748b] mb-6">
            <li>
              In n8n, open <strong className="text-[#111418]">Credentials → Add credential → Header Auth</strong>.
            </li>
            <li>
              Set Name to <code className="bg-[#f1f5f9] px-1 rounded">Authorization</code> and Value to{" "}
              <code className="bg-[#f1f5f9] px-1 rounded">Bearer avise_sk_…</code>.
            </li>
            <li>
              In an <strong className="text-[#111418]">HTTP Request</strong> node, choose Generic Credential
              Type → Header Auth and that credential, then call any endpoint below, e.g.{" "}
              <code className="bg-[#f1f5f9] px-1 rounded">GET https://app.avise.io/api/deals</code>.
            </li>
            <li>For POST and PATCH, send a JSON body. For uploads, send form-data with the file in a field named file.</li>
          </ol>
          <p className="text-sm text-[#64748b]">
            Zapier (Webhooks by Zapier), Make (HTTP module) and Postman work the same way: add the
            Authorization header with your key. Turn on retries for nodes that loop over many items.
          </p>
        </div>
      </div>

      {/* Webhooks */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="flex items-center gap-3 mb-6">
          <div className="size-10 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-600">
            <span className="material-symbols-outlined">webhook</span>
          </div>
          <h2 className="text-2xl font-bold text-[#111418]">Webhooks: get events instead of polling</h2>
        </div>
        <p className="text-[#64748b] mb-6">
          Add a URL in <strong className="text-[#111418]">Settings → Webhooks</strong> (or with{" "}
          <code className="bg-[#f1f5f9] px-1 rounded">POST /api/webhook-subscriptions</code>) and Avise POSTs each
          event to it within seconds. In n8n, use a <strong className="text-[#111418]">Webhook</strong> trigger node
          and paste its Production URL. URLs must be https.
        </p>
        <div className="rounded-xl border border-[#e2e8f0] bg-white overflow-x-auto mb-6">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e2e8f0]">
                <th className={th}>Event</th>
                <th className={th}>Sent when</th>
              </tr>
            </thead>
            <tbody className="text-[#64748b]">
              {WEBHOOK_EVENTS.map(([event, when], idx) => (
                <tr key={event} className={idx < WEBHOOK_EVENTS.length - 1 ? "border-b border-[#e2e8f0]" : ""}>
                  <td className="py-3 px-4 font-mono text-[13px] text-[#111418]">{event}</td>
                  <td className="py-3 px-4">{when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="font-semibold text-[#111418] mb-2">What your URL receives</h3>
            <pre className={pre}>
              <code className={preCode}>{`POST https://your-n8n.example.com/webhook/avise
Avise-Event: deal.stage_changed
Avise-Delivery: 7f9c…
Avise-Signature: t=1791000000,v1=5d41…

{
  "id": "7f9c…",
  "event": "deal.stage_changed",
  "createdAt": "2026-10-02T10:15:00.000Z",
  "organizationId": "…",
  "data": { "id": "…", "name": "Project Falcon",
            "stage": "DUE_DILIGENCE",
            "previousStage": "INITIAL_REVIEW", … }
}`}</code>
            </pre>
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-[#111418] mb-2">Verify the signature (optional, recommended)</h3>
            <pre className={pre}>
              <code className={preCode}>{`// Node.js — secret is the whsec_… shown when the webhook was added
const crypto = require("crypto");
const [t, v1] = header.split(",").map(p => p.split("=")[1]);
const expected = crypto.createHmac("sha256", secret)
  .update(\`\${t}.\${rawBody}\`).digest("hex");
const valid = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;`}</code>
            </pre>
          </div>
        </div>
        <p className="text-sm text-[#64748b] mt-6">
          Each event is sent once with a 5-second timeout; answer with any 2xx status. Failures show in Settings →
          Webhooks, where you can send a test event; after 20 failures in a row the webhook is paused until you
          resume it. Payloads carry the record&apos;s fields but not document text or nested lists — fetch
          details from the API when you need them. To catch up after downtime, list records with{" "}
          <code className="bg-[#f1f5f9] px-1 rounded">?updatedSince=</code> on deals, contacts, tasks or companies.
        </p>
      </div>

      {/* Endpoints */}
      <div className="bg-white py-16">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl font-bold text-[#111418] mb-2">Common endpoints</h2>
          <p className="text-[#64748b] mb-10">
            Base URL <code className="bg-[#f1f5f9] px-1 rounded">https://app.avise.io</code>. Bold fields are required.
          </p>
          <EndpointSections />
        </div>
      </div>

      {/* Rate Limits */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-[#111418] mb-6">Rate Limits</h2>
        <div className="rounded-xl border border-[#e2e8f0] bg-white overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e2e8f0]">
                <th className={th}>Tier</th>
                <th className={th}>Limit</th>
                <th className={th}>Window</th>
                <th className={th}>Applies To</th>
              </tr>
            </thead>
            <tbody className="text-[#64748b]">
              {RATE_LIMITS.map((row, idx) => (
                <tr
                  key={row.tier}
                  className={idx < RATE_LIMITS.length - 1 ? "border-b border-[#e2e8f0]" : ""}
                >
                  <td className="py-3 px-4 font-medium text-[#111418]">{row.tier}</td>
                  <td className="py-3 px-4">{row.limit}</td>
                  <td className="py-3 px-4">{row.window}</td>
                  <td className="py-3 px-4">{row.applies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Errors */}
      <div className="max-w-6xl mx-auto px-6 pb-16">
        <h2 className="text-2xl font-bold text-[#111418] mb-6">Errors</h2>
        <p className="text-[#64748b] mb-6">
          Errors are JSON with an <code className="bg-[#f1f5f9] px-1 rounded">error</code> message;
          validation errors add a <code className="bg-[#f1f5f9] px-1 rounded">details</code> list naming each field.
        </p>
        <div className="rounded-xl border border-[#e2e8f0] bg-white overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e2e8f0]">
                <th className={th}>Status</th>
                <th className={th}>Meaning</th>
                <th className={th}>What to do</th>
              </tr>
            </thead>
            <tbody className="text-[#64748b]">
              {ERRORS.map(([status, meaning, fix], idx) => (
                <tr key={status} className={idx < ERRORS.length - 1 ? "border-b border-[#e2e8f0]" : ""}>
                  <td className="py-3 px-4 font-mono font-medium text-[#111418]">{status}</td>
                  <td className="py-3 px-4">{meaning}</td>
                  <td className="py-3 px-4">{fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Full index */}
      <div className="bg-white py-16">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl font-bold text-[#111418] mb-2">All endpoints ({ENDPOINT_TOTAL})</h2>
          <p className="text-[#64748b] mb-8">
            Every endpoint that accepts an API key, grouped by area. Parts like{" "}
            <code className="bg-[#f1f5f9] px-1 rounded">:id</code> are ids you fill in.
          </p>
          <FullEndpointIndex />
        </div>
      </div>

      {/* CTA */}
      <div className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-2xl font-bold text-[#111418] mb-4">
            Need help with integrations?
          </h2>
          <p className="text-[#64748b] mb-8">
            Contact our team for guidance on building custom integrations with Avise.
          </p>
          <a
            href="mailto:hello@pocket-fund.com"
            className="inline-flex items-center gap-2 h-12 px-8 rounded-lg text-white font-bold hover:opacity-90 transition-colors"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined">mail</span>
            Contact Support
          </a>
        </div>
      </div>
    </MarketingPageShell>
  );
}
