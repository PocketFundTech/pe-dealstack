import type { Metadata } from "next";
import Link from "next/link";
import { MarketingPageShell } from "@/components/layout/MarketingPageShell";

export const metadata: Metadata = {
  title: "Resources - Avise",
  description:
    "Resources for Avise users. Documentation, API reference, help center and more — a richer landing page is coming soon.",
};

const RESOURCE_LINKS = [
  {
    href: "/documentation",
    title: "Documentation",
    blurb: "Step-by-step setup guides and feature walkthroughs.",
    icon: "menu_book",
  },
  {
    href: "/api-reference",
    title: "API Reference",
    blurb: "Endpoints, authentication, and rate limits for custom integrations.",
    icon: "code",
  },
  {
    href: "/help-center",
    title: "Help Center",
    blurb: "FAQs and troubleshooting for everyday questions.",
    icon: "help",
  },
];

export default function ResourcesPage() {
  return (
    <MarketingPageShell active="resources">
      <div className="max-w-5xl mx-auto px-6 py-20 lg:py-28">
        <div className="text-center mb-12">
          <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-6 tracking-tight">
            Resources
          </h1>
          <p className="text-lg text-[#64748b] max-w-2xl mx-auto">
            A fuller resources hub — guides, case studies, and webinars — is
            coming soon. In the meantime, here&apos;s what&apos;s already live.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {RESOURCE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group p-6 rounded-xl bg-white border border-[#e2e8f0] shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all"
            >
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary mb-4 group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined">{link.icon}</span>
              </div>
              <h3 className="font-bold text-[#111418] mb-1">{link.title}</h3>
              <p className="text-sm text-[#64748b]">{link.blurb}</p>
            </Link>
          ))}
        </div>
      </div>
    </MarketingPageShell>
  );
}
