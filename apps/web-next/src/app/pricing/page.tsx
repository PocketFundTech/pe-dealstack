import type { Metadata } from "next";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";
import { PricingTable } from "./PricingTable";

export const metadata: Metadata = {
  title: "Pricing - Deal Flow Software for PE Firms - Avise",
  description:
    "Flexible pricing plans for Avise. From emerging managers to global institutions, find the right plan for your private equity firm's needs.",
  alternates: { canonical: "/pricing" },
};

type Cell = { type: "text"; value: string } | { type: "check" } | { type: "cross" };

type FeatureRow = {
  feature: string;
  boutique: Cell;
  midMarket: Cell;
  enterprise: Cell;
};

type FeatureSection = { title: string; rows: FeatureRow[] };

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    title: "Core Platform",
    rows: [
      {
        feature: "Deal Ingestion",
        boutique: { type: "text", value: "Basic AI" },
        midMarket: { type: "text", value: "Advanced AI" },
        enterprise: { type: "text", value: "Custom Models" },
      },
      {
        feature: "Deal Rooms",
        boutique: { type: "text", value: "5 Active" },
        midMarket: { type: "text", value: "25 Active" },
        enterprise: { type: "text", value: "Unlimited" },
      },
      {
        feature: "Historical Data",
        boutique: { type: "text", value: "1 Year" },
        midMarket: { type: "text", value: "Unlimited" },
        enterprise: { type: "text", value: "Unlimited" },
      },
    ],
  },
  {
    title: "Intelligence & AI",
    rows: [
      {
        feature: "Chat with Deals",
        boutique: { type: "cross" },
        midMarket: { type: "check" },
        enterprise: { type: "check" },
      },
      {
        feature: "Sentiment Analysis",
        boutique: { type: "cross" },
        midMarket: { type: "check" },
        enterprise: { type: "check" },
      },
      {
        feature: "Custom API Access",
        boutique: { type: "cross" },
        midMarket: { type: "cross" },
        enterprise: { type: "check" },
      },
    ],
  },
  {
    title: "Support & Security",
    rows: [
      {
        feature: "Support SLA",
        boutique: { type: "text", value: "Standard" },
        midMarket: { type: "text", value: "Priority (24h)" },
        enterprise: { type: "text", value: "Dedicated (1h)" },
      },
      {
        feature: "SSO & Audit Logs",
        boutique: { type: "cross" },
        midMarket: { type: "cross" },
        enterprise: { type: "check" },
      },
    ],
  },
];

function CellRender({ cell }: { cell: Cell }) {
  if (cell.type === "check") {
    return <span className="material-symbols-outlined text-primary">check</span>;
  }
  if (cell.type === "cross") {
    return <span className="material-symbols-outlined text-[#cbd5e1]">remove</span>;
  }
  return (
    <span className="text-sm font-semibold text-[#111418]">{cell.value}</span>
  );
}

export default function PricingPage() {
  return (
    <MarketingPageShell active="pricing">
      <div className="w-full flex flex-1 justify-center py-10 lg:py-20 px-4 sm:px-8">
        <div className="flex flex-col max-w-[1200px] flex-1">
          {/* Page Heading */}
          <div className="flex flex-col items-center text-center gap-4 mb-10">
            <h1 className="text-[#111418] text-4xl lg:text-5xl font-extrabold leading-tight tracking-[-0.033em] max-w-3xl">
              Institutional-Grade Intelligence. <br className="hidden sm:block" />
              Tailored Pricing.
            </h1>
            <p className="text-[#64748b] text-lg font-normal leading-normal max-w-xl">
              Choose the plan that fits your firm&apos;s investment strategy. Scale from
              boutique sourcing to enterprise-grade operations.
            </p>
          </div>

          <PricingTable />

          {/* Feature Comparison Table */}
          <div className="flex flex-col mb-20">
            <div className="flex flex-col md:flex-row md:items-end justify-between px-4 pb-6 pt-5">
              <h2 className="text-[#111418] text-[28px] font-bold leading-tight tracking-[-0.015em]">
                Detailed Feature Comparison
              </h2>
            </div>
            <div className="rounded-xl border border-[#e2e8f0] bg-white shadow-sm">
              <table className="w-full text-left border-collapse">
                <thead className="bg-[#f8fafc]">
                  <tr>
                    <th className="p-4 md:p-6 text-sm font-bold text-[#64748b] border-b border-[#e2e8f0] w-1/3 min-w-[200px]">
                      Feature
                    </th>
                    <th className="p-4 md:p-6 text-center text-sm font-bold text-[#111418] border-b border-[#e2e8f0] min-w-[140px]">
                      Boutique
                    </th>
                    <th className="p-4 md:p-6 text-center text-sm font-bold text-primary border-b border-[#e2e8f0] min-w-[140px]">
                      Mid-Market
                    </th>
                    <th className="p-4 md:p-6 text-center text-sm font-bold text-[#111418] border-b border-[#e2e8f0] min-w-[140px]">
                      Enterprise
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e2e8f0]">
                  {FEATURE_SECTIONS.map((section) => (
                    <Section key={section.title} section={section} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom CTA */}
          <div className="flex flex-col items-center justify-center p-8 md:p-12 rounded-2xl bg-gradient-to-br from-[#1269e2]/10 to-[#1269e2]/5 border border-[#1269e2]/10">
            <h2 className="text-2xl md:text-3xl font-bold text-[#111418] mb-4 text-center">
              Ready to modernize your deal flow?
            </h2>
            <p className="text-[#64748b] text-center max-w-2xl mb-8">
              Join the hundreds of investment firms already using Avise to gain a
              competitive information advantage.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <a
                href="/signup"
                className="flex min-w-[160px] items-center justify-center rounded-lg h-12 px-6 text-white text-base font-bold tracking-[0.015em] hover:opacity-90 transition-colors shadow-lg"
                style={{ backgroundColor: "#003366" }}
              >
                Start Free Trial
              </a>
              <a
                href="mailto:hello@pocket-fund.com?subject=Demo%20Request"
                className="flex min-w-[160px] items-center justify-center rounded-lg h-12 px-6 bg-white border border-[#d1d5db] text-[#111418] text-base font-bold tracking-[0.015em] hover:bg-gray-50 transition-colors"
              >
                Book a Demo
              </a>
            </div>
          </div>
        </div>
      </div>
    </MarketingPageShell>
  );
}

function Section({ section }: { section: FeatureSection }) {
  return (
    <>
      <tr>
        <td
          className="bg-[#f1f5f9] p-3 px-6 text-xs font-bold uppercase tracking-wider text-[#64748b]"
          colSpan={4}
        >
          {section.title}
        </td>
      </tr>
      {section.rows.map((row) => (
        <tr key={row.feature} className="hover:bg-gray-50">
          <td className="p-4 md:p-6 text-sm font-medium text-[#111418] bg-white">
            {row.feature}
          </td>
          <td className="p-4 md:p-6 text-center">
            <CellRender cell={row.boutique} />
          </td>
          <td className="p-4 md:p-6 text-center">
            <CellRender cell={row.midMarket} />
          </td>
          <td className="p-4 md:p-6 text-center">
            <CellRender cell={row.enterprise} />
          </td>
        </tr>
      ))}
    </>
  );
}
