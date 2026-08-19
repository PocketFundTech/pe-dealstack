import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";
import { EndpointSections } from "./sections";

export const metadata: Metadata = {
  title: "API Reference - Avise",
  description:
    "Avise REST API reference. Build custom integrations with authentication, deals, ingestion, documents, memos, export, and audit endpoints.",
};

const RATE_LIMITS = [
  {
    tier: "General",
    limit: "200 requests",
    window: "15 minutes",
    applies: "All GET endpoints",
  },
  {
    tier: "Write",
    limit: "30 requests",
    window: "1 minute",
    applies: "POST, PATCH, DELETE endpoints",
  },
  {
    tier: "AI",
    limit: "10 requests",
    window: "1 minute",
    applies: "Chat, ingestion, memo generation",
  },
];

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
            Build custom integrations with the Avise REST API. All endpoints
            require authentication via Bearer token.
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-[#e2e8f0] font-mono text-sm">
            <span className="text-[#64748b]">Base URL:</span>
            <span className="text-primary font-semibold">
              https://pe-os.onrender.com/api
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
          <h2 className="text-2xl font-bold text-[#111418]">Authentication</h2>
        </div>
        <div className="p-6 rounded-xl bg-white border border-[#e2e8f0] shadow-sm mb-6">
          <p className="text-[#64748b] mb-4">
            Avise uses{" "}
            <strong className="text-[#111418]">Supabase Auth</strong> with JWT
            tokens. Obtain a token by signing in through the Supabase Auth API,
            then include it as a Bearer token in all requests.
          </p>
          <pre className="bg-[#1e293b] rounded-lg p-4 overflow-x-auto">
            <code className="text-gray-300 font-mono text-[13px] leading-relaxed whitespace-pre">{`// Include in all API requests
Authorization: Bearer YOUR_SUPABASE_JWT_TOKEN`}</code>
          </pre>
        </div>
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <strong>Note:</strong> Tokens expire after 1 hour. Use the Supabase
          refresh token flow to obtain new access tokens without re-authenticating.
        </div>
      </div>

      {/* Endpoints */}
      <div className="bg-white py-16">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-2xl font-bold text-[#111418] mb-10">Endpoints</h2>
          <EndpointSections />
        </div>
      </div>

      {/* Rate Limits */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-[#111418] mb-6">Rate Limits</h2>
        <div className="rounded-xl border border-[#e2e8f0] bg-white">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[#e2e8f0]">
                <th className="text-left py-3 px-4 font-semibold text-[#111418]">Tier</th>
                <th className="text-left py-3 px-4 font-semibold text-[#111418]">Limit</th>
                <th className="text-left py-3 px-4 font-semibold text-[#111418]">Window</th>
                <th className="text-left py-3 px-4 font-semibold text-[#111418]">Applies To</th>
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
