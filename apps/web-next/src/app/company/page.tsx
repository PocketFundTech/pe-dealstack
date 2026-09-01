import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";

export const metadata: Metadata = {
  title: "Company - Avise",
  description:
    "About Avise. Our company page is coming soon — meet the team behind the AI-powered operating system for private equity.",
  // Same reasoning as solutions/page.tsx — placeholder copy, keep out of
  // the index until the real page ships.
  robots: { index: false, follow: true },
};

export default function CompanyPage() {
  return (
    <MarketingPageShell active="company">
      <div className="max-w-3xl mx-auto px-6 py-20 lg:py-28 text-center">
        <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-6 tracking-tight">
          Company
        </h1>
        <p className="text-lg text-[#64748b] mb-8">
          We&apos;re drafting the story of who we are and why we&apos;re
          building Avise. Until then, browse the platform or reach out — we
          love hearing from prospective customers and collaborators.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-lg text-white font-bold hover:opacity-90 transition-colors"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined">arrow_back</span>
            Back to home
          </Link>
          <a
            href="mailto:hello@pocket-fund.com?subject=Hello%20PE%20OS"
            className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-lg bg-[#f1f5f9] text-[#111418] font-bold hover:bg-[#e2e8f0] transition-colors"
          >
            <span className="material-symbols-outlined">mail</span>
            Get in touch
          </a>
        </div>
      </div>
    </MarketingPageShell>
  );
}
