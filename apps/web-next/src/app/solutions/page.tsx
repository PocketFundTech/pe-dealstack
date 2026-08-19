import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";

export const metadata: Metadata = {
  title: "Solutions - Avise",
  description:
    "Solutions for private equity firms — coming soon. Learn how Avise supports sourcing, diligence, portfolio operations, and reporting.",
};

export default function SolutionsPage() {
  return (
    <MarketingPageShell active="solutions">
      <div className="max-w-3xl mx-auto px-6 py-20 lg:py-28 text-center">
        <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-6 tracking-tight">
          Solutions
        </h1>
        <p className="text-lg text-[#64748b] mb-8">
          We&apos;re putting the finishing touches on a deep dive into how Avise
          supports sourcing, diligence, portfolio operations, and LP reporting
          across firm sizes. Check back soon — or reach out if you&apos;d like a
          tailored walkthrough today.
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
            href="mailto:hello@pocket-fund.com?subject=Solutions%20Inquiry"
            className="inline-flex items-center justify-center gap-2 h-12 px-8 rounded-lg bg-[#f1f5f9] text-[#111418] font-bold hover:bg-[#e2e8f0] transition-colors"
          >
            <span className="material-symbols-outlined">mail</span>
            Talk to us
          </a>
        </div>
      </div>
    </MarketingPageShell>
  );
}
