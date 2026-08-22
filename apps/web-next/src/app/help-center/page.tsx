import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";

export const metadata: Metadata = {
  title: "Help Center - Avise",
  description:
    "Find answers to common questions about Avise. FAQs on account setup, deal management, AI features, security, billing, and troubleshooting.",
  alternates: { canonical: "/help-center" },
};

type Faq = { q: string; a: React.ReactNode };
type Category = {
  id: string;
  title: string;
  blurb: string;
  iconKey: string;
  iconWrapClass: string;
  faqs: Faq[];
};

const CATEGORIES: Category[] = [
  {
    id: "account",
    title: "Account & Setup",
    blurb: "Registration, login, profile, team setup",
    iconKey: "person",
    iconWrapClass: "bg-blue-500/10 text-blue-600",
    faqs: [
      {
        q: "How do I create an account?",
        a: (
          <>
            Click &quot;Get Started&quot; on the homepage or visit the{" "}
            <Link href="/signup" className="text-primary hover:underline">
              sign up page
            </Link>
            . Enter your email, full name, firm name, and password. You&apos;ll
            receive a verification email — click the link to activate your
            account. The first user in a workspace automatically gets the Admin
            role.
          </>
        ),
      },
      {
        q: "How do I invite team members?",
        a: (
          <>
            Go to <strong>Settings</strong> from the sidebar, then click
            &quot;Invite Team Member.&quot; Enter the person&apos;s email and
            select their role (Admin, Member, or Viewer). They&apos;ll receive
            an email invitation with a link to join your workspace. Invitations
            expire after 7 days.
          </>
        ),
      },
      {
        q: "What are the different user roles?",
        a: (
          <>
            <strong>Admin</strong> — full access including user management,
            audit logs, data export, and all deal operations.{" "}
            <strong>Member</strong> — standard access to create, edit, and view
            deals, upload documents, and use AI features.{" "}
            <strong>Viewer</strong> — read-only access to view deals and
            documents. Display titles (MD, VP, Associate, Analyst) are separate
            and don&apos;t affect permissions.
          </>
        ),
      },
      {
        q: "I forgot my password. How do I reset it?",
        a: 'Click "Forgot Password" on the login page, enter your email, and we\'ll send a reset link. The link is valid for 1 hour. If you don\'t receive the email, check your spam folder or contact support.',
      },
    ],
  },
  {
    id: "deals",
    title: "Deal Management",
    blurb: "Importing, editing, tracking deals",
    iconKey: "handshake",
    iconWrapClass: "bg-emerald-500/10 text-emerald-600",
    faqs: [
      {
        q: "What file types can I upload?",
        a: "Avise supports PDF, Word (.docx), Excel (.xlsx, .csv), plain text (.txt), and email (.eml) files. Maximum file size is 50MB. Excel files with multiple rows are processed as bulk imports, creating one deal per row.",
      },
      {
        q: "How do deal stages work?",
        a: (
          <>
            Deals progress through stages: <strong>Initial Review</strong>{" "}
            (first look), <strong>Due Diligence</strong> (detailed analysis),{" "}
            <strong>LOI</strong> (letter of intent), <strong>Closing</strong>{" "}
            (final negotiation), <strong>Closed</strong> (deal done), or{" "}
            <strong>Passed</strong> (declined). Change the stage from the deal
            detail page or CRM list view.
          </>
        ),
      },
      {
        q: "Can I import deals from a company website URL?",
        a: 'Yes. Go to Deal Intake, select the "Enter URL" tab, and paste the company\'s website. Avise scrapes multiple pages (About, Team, Products, etc.) and uses AI to extract deal-relevant information. You can preview the extraction before creating the deal.',
      },
      {
        q: "How do I export my deal data?",
        a: (
          <>
            Admins can export all deal data via the API:{" "}
            <code className="bg-[#e2e8f0] px-1.5 py-0.5 rounded text-xs font-mono">
              GET /api/export/deals?format=csv
            </code>{" "}
            for CSV or{" "}
            <code className="bg-[#e2e8f0] px-1.5 py-0.5 rounded text-xs font-mono">
              format=json
            </code>{" "}
            for JSON. Every export is audit-logged for compliance.
          </>
        ),
      },
    ],
  },
  {
    id: "ai",
    title: "AI Features",
    blurb: "Extraction, chat, memo generation",
    iconKey: "psychology",
    iconWrapClass: "bg-violet-500/10 text-violet-600",
    faqs: [
      {
        q: "How does AI data extraction work?",
        a: "When you upload a document, Avise extracts the text content, then sends it to GPT-4 with a specialized prompt for PE deal analysis. The AI identifies company name, industry, revenue, EBITDA, margins, employee count, and more. Each field gets a confidence score (0-100%). Fields below 60% are flagged for manual review. Financial data is also validated against PE industry norms.",
      },
      {
        q: 'What is "Chat with Deals"?',
        a: 'Chat with Deals lets you ask natural language questions about any deal. The AI searches across all documents uploaded for that deal using RAG (Retrieval-Augmented Generation) and provides answers with context. Try questions like: "What\'s the revenue trend?", "Who are the key executives?", or "Summarize the competitive landscape."',
      },
      {
        q: "What does multi-document analysis do?",
        a: "When a deal has 2 or more documents, Avise can cross-reference them to detect conflicts (e.g., different revenue figures in the CIM vs teaser), fill data gaps (one doc has info the other doesn't), and synthesize insights across all sources. This runs automatically when you upload additional documents, or you can trigger it manually.",
      },
      {
        q: "Is my data used to train AI models?",
        a: "No. Your deal data is never used to train AI models. We use the OpenAI API with data processing agreements that explicitly prohibit using customer data for model training. Your confidential deal information stays confidential.",
      },
    ],
  },
  {
    id: "security",
    title: "Security & Privacy",
    blurb: "Encryption, compliance, data protection",
    iconKey: "shield",
    iconWrapClass: "bg-teal-500/10 text-teal-600",
    faqs: [
      {
        q: "How is my data encrypted?",
        a: "Avise uses AES-256-GCM encryption for sensitive deal data at rest, with unique initialization vectors per encryption. All data in transit is protected with TLS 1.3. Database connections use SSL. Encryption keys are managed server-side and never exposed to clients.",
      },
      {
        q: "What is the audit trail?",
        a: "Every action in Avise is logged to an immutable audit trail — deal creation, edits, deletions, document uploads, AI extractions, exports, and login events. Audit logs cannot be modified or deleted (INSERT-ONLY), meeting SEC/regulatory requirements. Admins can filter logs by date, action type, resource, and severity.",
      },
      {
        q: "Can I export or delete all my data?",
        a: "Yes. You can export all deal data at any time in CSV or JSON format. For account deletion, contact our support team and we'll permanently delete all your data within 30 days, in compliance with data protection regulations.",
      },
    ],
  },
  {
    id: "billing",
    title: "Billing & Plans",
    blurb: "Pricing, trials, upgrades, invoices",
    iconKey: "payments",
    iconWrapClass: "bg-amber-500/10 text-amber-600",
    faqs: [
      {
        q: "Is there a free trial?",
        a: "Yes. Avise offers a 14-day free trial with full access to Mid-Market tier features. No credit card required. You can import deals, use AI features, invite team members, and evaluate the platform risk-free.",
      },
      {
        q: "What plans are available?",
        a: "We offer tiers for emerging funds, mid-market firms, and enterprise PE firms. All plans include core AI features, deal tracking, and document management. Contact sales for current pricing and upgrade options.",
      },
      {
        q: "How do I upgrade or change my plan?",
        a: (
          <>
            Contact our sales team at{" "}
            <a
              href="mailto:hello@pocket-fund.com"
              className="text-primary hover:underline"
            >
              hello@pocket-fund.com
            </a>{" "}
            to discuss plan changes. Upgrades take effect immediately, and
            we&apos;ll prorate any billing differences.
          </>
        ),
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    blurb: "Common issues and how to fix them",
    iconKey: "build",
    iconWrapClass: "bg-rose-500/10 text-rose-600",
    faqs: [
      {
        q: "My document upload failed. What should I do?",
        a: "Check that your file is under 50MB and in a supported format (PDF, Word, Excel, CSV, TXT, EML). If the file is password-protected, remove the password first. For scanned PDFs without searchable text, try using a PDF with OCR text layer. If the issue persists, contact support with the file details.",
      },
      {
        q: "The AI extraction has low confidence scores. Why?",
        a: "Low confidence usually means the document doesn't contain clear financial or company data. This is common with early-stage teasers, NDAs, or heavily redacted documents. You can manually edit the extracted fields on the deal page. Uploading additional documents (CIM, financial model) will improve data quality through multi-document analysis.",
      },
      {
        q: "The page is loading slowly. What can I do?",
        a: "Avise is hosted on Render's free tier, which may experience a cold start delay of up to 50 seconds after periods of inactivity. Once warmed up, subsequent requests are fast. For production use, we recommend upgrading to a paid tier for always-on performance.",
      },
      {
        q: 'I\'m getting a "session expired" error. What do I do?',
        a: "Authentication tokens expire after 1 hour for security. Simply refresh the page or log in again. If you're being logged out frequently, make sure your browser isn't blocking cookies or local storage for the Avise domain.",
      },
    ],
  },
];

export default function HelpCenterPage() {
  return (
    <MarketingPageShell active="resources">
      {/* Hero */}
      <div className="bg-gradient-to-br from-amber-500/5 to-orange-50 py-20">
        <div className="max-w-6xl mx-auto px-6 text-center">
          <nav className="flex items-center justify-center gap-2 text-sm text-[#64748b] mb-6">
            <Link href="/resources" className="hover:text-primary transition-colors">
              Resources
            </Link>
            <span className="material-symbols-outlined text-base">chevron_right</span>
            <span className="text-[#111418] font-medium">Help Center</span>
          </nav>
          <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-6">
            Help Center
          </h1>
          <p className="text-lg text-[#64748b] max-w-3xl mx-auto">
            Find answers to common questions and troubleshooting guides.
          </p>
        </div>
      </div>

      {/* Category Cards */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {CATEGORIES.map((cat) => (
            <a
              key={cat.id}
              href={`#${cat.id}`}
              className="group p-6 rounded-xl bg-white border border-[#e2e8f0] shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all"
            >
              <div
                className={`size-10 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform ${cat.iconWrapClass}`}
              >
                <span className="material-symbols-outlined">{cat.iconKey}</span>
              </div>
              <h3 className="font-bold text-[#111418] mb-1">{cat.title}</h3>
              <p className="text-sm text-[#64748b]">{cat.blurb}</p>
            </a>
          ))}
        </div>
      </div>

      {/* FAQ Sections */}
      <div className="bg-white py-16">
        <div className="max-w-4xl mx-auto px-6">
          {CATEGORIES.map((cat) => (
            <div id={cat.id} key={cat.id} className="mb-12 scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div
                  className={`size-8 rounded-lg flex items-center justify-center ${cat.iconWrapClass}`}
                >
                  <span className="material-symbols-outlined text-xl">{cat.iconKey}</span>
                </div>
                <h2 className="text-xl font-bold text-[#111418]">{cat.title}</h2>
              </div>
              <div className="space-y-3">
                {cat.faqs.map((faq) => (
                  <details
                    key={faq.q}
                    className="group p-5 rounded-xl bg-[#f8fafc] border border-[#e2e8f0]"
                  >
                    <summary className="flex items-center justify-between cursor-pointer list-none font-semibold text-[#111418] text-sm">
                      {faq.q}
                      <span className="material-symbols-outlined text-[#64748b] group-open:rotate-180 transition-transform text-lg">
                        expand_more
                      </span>
                    </summary>
                    <p className="mt-3 text-sm text-[#64748b]">{faq.a}</p>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Contact Support */}
      <div className="py-16">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-2xl font-bold text-[#111418] mb-4">
            Still have questions?
          </h2>
          <p className="text-[#64748b] mb-8">
            Our support team is here to help. Reach out anytime.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="mailto:hello@pocket-fund.com"
              className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-lg text-white font-bold hover:opacity-90 transition-colors"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined">mail</span>
              Email Support
            </a>
            <Link
              href="/documentation"
              className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-lg bg-[#f1f5f9] text-[#111418] font-bold hover:bg-[#e2e8f0] transition-colors"
            >
              <span className="material-symbols-outlined">menu_book</span>
              Browse Documentation
            </Link>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}
