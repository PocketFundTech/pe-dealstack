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
  ["Can reach", "Every endpoint below, with that admin's permissions"],
  ["Cannot do", "Create, list or revoke API keys (sign in to Avise for that)"],
  ["Expiry", "Never, 30 days, 90 days or 1 year, chosen at creation"],
  ["Shown", "Once, at creation. Avise stores only a fingerprint of it"],
  ["Stops working", "When revoked or expired, or when its creator is deactivated or leaves the organization"],
];

const ERRORS = [
  ["400", "A field is missing or invalid", "Read details in the response and fix the body"],
  ["401", "API key wrong, revoked or expired", "Create a new key in Settings → API Keys"],
  ["403", "The key's owner lacks permission, or MFA_REQUIRED", "Use an admin's key, or the owner sets up 2FA"],
  ["404", "Record not found in your organization", "Check the id"],
  ["409", "Duplicate contact email, or the deal changed since you read it", "Use existingContactId, or re-read and retry"],
  ["413", "Request body over 4.5 MB", "Use the signed upload (POST /api/uploads/sign)"],
  ["429", "Rate limit reached", "Wait until the RateLimit-Reset header says"],
  ["503", "AI provider unavailable (AI endpoints only)", "Retry later"],
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
            where it will live (for example &ldquo;n8n — deal intake&rdquo;), pick an expiry, and copy
            it when it is shown: it is never shown again. Send it on every request:
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
