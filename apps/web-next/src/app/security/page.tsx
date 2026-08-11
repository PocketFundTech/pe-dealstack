import type { Metadata } from "next";
import {
  LegalH2,
  LegalH3,
  LegalList,
  LegalP,
  LegalPageShell,
} from "@/components/layout/LegalPageShell";

export const metadata: Metadata = {
  title: "Security & Trust",
  description:
    "How Pocket Fund protects PE deal data: encryption, tenant isolation, sub-processors, compliance roadmap.",
};

const SUB_PROCESSORS: Array<{
  provider: string;
  service: string;
  region: string;
  certifications: string;
  dpaUrl: string;
}> = [
  {
    provider: "Supabase",
    service: "Database, authentication, file storage",
    region: "US (AWS)",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://supabase.com/dpa",
  },
  {
    provider: "Vercel",
    service: "Application hosting (serverless)",
    region: "Global (edge)",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://vercel.com/legal/dpa",
  },
  {
    provider: "OpenAI",
    service: "GPT-4o (extraction, classification, chat)",
    region: "US",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://openai.com/policies/data-processing-addendum",
  },
  {
    provider: "Anthropic",
    service: "Claude (financial cross-verification)",
    region: "US",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://www.anthropic.com/legal/dpa",
  },
  {
    provider: "Google",
    service: "Gemini (LLM router fallback)",
    region: "US",
    certifications: "SOC 2",
    dpaUrl: "https://cloud.google.com/terms/data-processing-addendum",
  },
  {
    provider: "Microsoft Azure",
    service: "Document Intelligence (PDF extraction)",
    region: "US",
    certifications: "SOC 2 Type II, ISO 27001",
    dpaUrl:
      "https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA",
  },
  {
    provider: "Apify",
    service: "Web search (firm research agent)",
    region: "US/EU",
    certifications: "SOC 2",
    dpaUrl: "https://apify.com/data-processing-agreement",
  },
  {
    provider: "Resend",
    service: "Transactional email (invitations, alerts)",
    region: "US",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://resend.com/legal/dpa",
  },
  {
    provider: "Sentry",
    service:
      "Error monitoring (sanitized stack traces only — no customer data in payloads)",
    region: "US",
    certifications: "SOC 2 Type II",
    dpaUrl: "https://sentry.io/legal/dpa/",
  },
];

const TRUST_BADGES = [
  "Supabase SOC 2 Type II",
  "Vercel SOC 2 Type II",
  "AES-256 at rest",
  "TLS 1.2+ in transit",
  "34 automated isolation tests",
];

export default function SecurityPage() {
  return (
    <LegalPageShell
      title="Security & Trust"
      lastUpdated="April 30, 2026"
      activeFooterLink="security"
      maxWidth="4xl"
    >
      {/* Hero */}
      <section className="bg-[#f1f5f9] rounded-xl p-8">
        <LegalH2>Your deal data, secured.</LegalH2>
        <LegalP>
          Pocket Fund is built for private equity firms handling LOIs, signed
          NDAs, and confidential CIMs. Security is foundational — not a
          checklist.
        </LegalP>
        <div className="flex flex-wrap gap-2 mb-6">
          {TRUST_BADGES.map((badge) => (
            <span
              key={badge}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white text-primary border border-[#e5e7eb]"
            >
              {badge}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <a
            href="/assets/pocket-fund-security-overview.pdf"
            download
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg text-sm font-bold text-white hover:opacity-90 transition-colors shadow-sm"
            style={{ backgroundColor: "#003366" }}
          >
            Download Security Overview (PDF)
          </a>
          <a
            href="mailto:security@pocket-fund.com?subject=DPA%20Request"
            className="inline-flex items-center justify-center px-5 py-2.5 bg-transparent border border-primary rounded-lg text-sm font-bold text-primary hover:bg-slate-100 transition-colors"
          >
            Request DPA
          </a>
        </div>
      </section>

      {/* Where data lives */}
      <section id="data-location">
        <LegalH2>Where your data lives</LegalH2>
        <LegalP>
          All Pocket Fund data is processed and stored on enterprise-grade,
          SOC 2 Type II certified infrastructure:
        </LegalP>
        <LegalList>
          <li>
            <strong>Database, authentication, file storage:</strong> Supabase
            (AWS, US region) — SOC 2 Type II
          </li>
          <li>
            <strong>Application hosting:</strong> Vercel (serverless, global
            edge) — SOC 2 Type II
          </li>
          <li>
            <strong>AI processing:</strong> OpenAI, Anthropic, Google (each
            SOC 2 Type II); Azure Document Intelligence
          </li>
        </LegalList>
        <LegalP>
          No customer data is stored on unmanaged servers or developer
          machines. See full sub-processor list below.
        </LegalP>
      </section>

      {/* Encryption */}
      <section id="encryption">
        <LegalH2>Encryption</LegalH2>
        <LegalH3>In transit</LegalH3>
        <LegalP>
          TLS 1.2 or higher on all connections. TLS 1.3 negotiated when
          supported by client. HTTPS enforced via HSTS.
        </LegalP>
        <LegalH3>At rest</LegalH3>
        <LegalP>
          PostgreSQL encrypted with <strong>AES-256</strong> via
          Supabase-managed disk encryption. File storage encrypted at rest by
          Supabase Storage. Encrypted automated backups retained per Supabase
          policy.
        </LegalP>
      </section>

      {/* Tenant isolation */}
      <section id="isolation">
        <LegalH2>Tenant isolation</LegalH2>
        <LegalP>
          Every record in every scoped table is tagged with an{" "}
          <code className="px-1.5 py-0.5 rounded bg-[#f1f5f9] text-primary text-sm">
            organizationId
          </code>
          . Server-side middleware enforces this on every API route — there
          is no &quot;trust the client&quot; path.
        </LegalP>
        <LegalP>
          <strong>How we prove it:</strong>
        </LegalP>
        <LegalList>
          <li>
            <strong>34 automated cross-organization tests</strong> run on
            every deploy. Each one actively attempts to read or write another
            organization&apos;s data and verifies the API rejects it.
          </li>
          <li>
            <strong>268 explicit org-scope checks</strong> across 45 API
            route files (audited 2026-04-30).
          </li>
          <li>
            Cross-org access attempts return HTTP 404, not 403, to prevent
            resource enumeration.
          </li>
        </LegalList>
        <LegalP>
          Customers on the Team plan or higher can run a live isolation check
          from their Settings → Security panel and download a JSON report.
        </LegalP>
      </section>

      {/* AI handling */}
      <section id="ai">
        <LegalH2>AI &amp; LLM data handling</LegalH2>
        <LegalP>
          Pocket Fund uses AI from OpenAI, Anthropic, Google, and Azure. We
          use the <strong>API tiers</strong> of each, which contractually do
          not train models on customer data.
        </LegalP>
        <LegalList>
          <li>
            OpenAI: API data not used for training (
            <a
              className="text-primary hover:underline"
              href="https://openai.com/enterprise-privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              policy
            </a>
            )
          </li>
          <li>
            Anthropic: API data not used for training (
            <a
              className="text-primary hover:underline"
              href="https://www.anthropic.com/legal/privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              policy
            </a>
            )
          </li>
          <li>
            Google Gemini: API data not used for training (
            <a
              className="text-primary hover:underline"
              href="https://ai.google.dev/gemini-api/terms"
              target="_blank"
              rel="noopener noreferrer"
            >
              policy
            </a>
            )
          </li>
          <li>
            Azure Document Intelligence: customer data isolated, not used for
            model improvement
          </li>
        </LegalList>
        <LegalP>
          Your CIMs, LOIs, and memos never feed any model — ours or theirs.
        </LegalP>
      </section>

      {/* Access controls */}
      <section id="access">
        <LegalH2>Access controls</LegalH2>
        <LegalList>
          <li>
            <strong>Authentication:</strong> Supabase Auth with optional
            TOTP-based two-factor authentication (Google Authenticator, Authy,
            1Password compatible)
          </li>
          <li>
            <strong>Org-wide MFA enforcement:</strong> admins can require all
            members to enable 2FA
          </li>
          <li>
            <strong>9-tier role-based access control:</strong> admin, partner,
            principal, vp, associate, analyst, ops, member, viewer
          </li>
          <li>
            <strong>Rate limiting:</strong> three tiers — general (600 req /
            15 min), AI (10 req / min), writes (30 req / min)
          </li>
          <li>
            <strong>Standard hardening:</strong> helmet middleware, CORS
            allow-list, JWT-based session tokens
          </li>
        </LegalList>
      </section>

      {/* Audit logging */}
      <section id="audit">
        <LegalH2>Audit logging</LegalH2>
        <LegalP>
          Every sensitive action is logged with timestamp, user ID,
          organization ID, resource ID, action, and severity. Customer admins
          can view, filter, and export their organization&apos;s audit log
          directly from the Admin Dashboard.
        </LegalP>
        <LegalP>Tracked actions include:</LegalP>
        <LegalList>
          <li>
            Authentication events (login, logout, failed login, password
            reset, MFA changes)
          </li>
          <li>
            Deal lifecycle (created, updated, deleted, viewed, stage changed,
            assigned, exported)
          </li>
          <li>Document operations (uploaded, deleted, downloaded, viewed)</li>
          <li>
            Memo operations (created, updated, deleted, approved, exported,
            shared)
          </li>
          <li>
            User management (created, updated, deleted, invited, role changed)
          </li>
          <li>
            System operations (settings changed, bulk export, API key
            lifecycle, isolation test runs)
          </li>
        </LegalList>
        <LegalP>
          60+ distinct action types across 9 resource types are tracked.
        </LegalP>
      </section>

      {/* Sub-processors */}
      <section id="sub-processors">
        <LegalH2>Sub-processors</LegalH2>
        <LegalP>
          The third parties that process customer data on our behalf, listed
          below. We notify customers 30 days before adding any new
          sub-processor.
        </LegalP>
        <div className="overflow-x-auto rounded-lg border border-[#e5e7eb]">
          <table className="w-full text-sm text-left">
            <thead className="bg-[#f8fafc] text-[#111418]">
              <tr>
                <th className="px-4 py-3 font-semibold border-b border-[#e5e7eb]">
                  Provider
                </th>
                <th className="px-4 py-3 font-semibold border-b border-[#e5e7eb]">
                  Service
                </th>
                <th className="px-4 py-3 font-semibold border-b border-[#e5e7eb]">
                  Region
                </th>
                <th className="px-4 py-3 font-semibold border-b border-[#e5e7eb]">
                  Certifications
                </th>
                <th className="px-4 py-3 font-semibold border-b border-[#e5e7eb]">
                  DPA
                </th>
              </tr>
            </thead>
            <tbody className="text-slate-600">
              {SUB_PROCESSORS.map((sp, idx) => (
                <tr
                  key={sp.provider}
                  className={
                    idx < SUB_PROCESSORS.length - 1
                      ? "border-b border-[#e5e7eb]"
                      : ""
                  }
                >
                  <td className="px-4 py-3 font-medium text-[#111418]">
                    {sp.provider}
                  </td>
                  <td className="px-4 py-3">{sp.service}</td>
                  <td className="px-4 py-3">{sp.region}</td>
                  <td className="px-4 py-3">{sp.certifications}</td>
                  <td className="px-4 py-3">
                    <a
                      className="text-primary hover:underline"
                      href={sp.dpaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      DPA
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Founder pledge */}
      <section id="founder-pledge" className="bg-[#f8fafc] rounded-xl p-8 border border-border-subtle">
        <LegalH2>Founder pledge</LegalH2>
        <LegalP>
          I, Ganesh Jagtap, founder of Pocket Fund, commit to the following — in
          plain language, signed and dated, with my name on it:
        </LegalP>
        <ul className="list-disc pl-6 space-y-2 my-4 text-text-secondary">
          <li>
            <strong>We will never sell, share, or repurpose your data.</strong>{" "}
            Your deal pipeline, LOIs, valuation models, and contacts are yours.
            We are a custodian, not an owner.
          </li>
          <li>
            <strong>Your data is never used to train AI models</strong> — ours,
            OpenAI&apos;s, Anthropic&apos;s, Google&apos;s, or any other
            provider&apos;s. We use API tiers explicitly because they exclude
            customer data from training.
          </li>
          <li>
            <strong>Pocket Fund staff access is logged.</strong> Every time any
            member of our team accesses your data, you see it in real-time in
            Settings → Security &amp; Privacy. Today, the count is zero. We
            intend to keep it there.
          </li>
          <li>
            <strong>You will get 90 days notice</strong> before we add any new
            sub-processor, with a clear opt-out path.
          </li>
          <li>
            <strong>Breach notification within 72 hours.</strong> If your data
            is ever exposed, you will hear from me directly — by phone or
            email, not via a buried status page update.
          </li>
          <li>
            <strong>You can leave at any time.</strong> Full data export on
            request, complete deletion within 30 days of contract end, with a
            signed deletion certificate.
          </li>
          <li>
            <strong>The founder is personally accountable.</strong> If anything
            goes sideways, you have a name to call:{" "}
            <a
              className="text-primary hover:underline"
              href="mailto:ganesh@pocket-fund.com"
            >
              ganesh@pocket-fund.com
            </a>
            .
          </li>
        </ul>
        <p className="mt-6 text-text-main">
          <strong className="block text-lg" style={{ color: "#003366" }}>
            Ganesh Jagtap
          </strong>
          <span className="text-sm text-text-muted">Founder, Pocket Fund</span>
        </p>
        <p className="text-xs text-text-muted mt-2">
          Last signed: May 2026
        </p>
      </section>

      {/* Compliance roadmap */}
      <section id="compliance">
        <LegalH2>Compliance roadmap</LegalH2>
        <LegalList>
          <li>
            <strong>SOC 2 Type I:</strong> in progress; target completion
            date available on request.
          </li>
          <li>
            <strong>SOC 2 Type II:</strong> following Type I
          </li>
          <li>
            <strong>Annual penetration test:</strong> planned for the next
            quarter
          </li>
          <li>
            <strong>GDPR:</strong> DPA available on request; data deletion
            within 30 days of contract termination
          </li>
        </LegalList>
      </section>

      {/* Contact */}
      <section id="contact" className="bg-[#f1f5f9] rounded-xl p-8">
        <LegalH2>Contact</LegalH2>
        <LegalP>
          Security questions, vulnerability reports, or compliance inquiries:{" "}
          <a
            className="text-primary hover:underline"
            href="mailto:security@pocket-fund.com"
          >
            security@pocket-fund.com
          </a>
        </LegalP>
        <LegalP>
          Urgent security issues:{" "}
          <a
            className="text-primary hover:underline"
            href="mailto:tech@pocket-fund.com"
          >
            tech@pocket-fund.com
          </a>
        </LegalP>
        <LegalP>
          For DPA, MNDA, or sub-processor list requests, email above with
          subject line indicating the request type.
        </LegalP>
      </section>
    </LegalPageShell>
  );
}
