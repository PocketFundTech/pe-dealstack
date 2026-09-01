/**
 * Structured data for the marketing site. Renders once in the root layout —
 * every page inherits Organization + SoftwareApplication JSON-LD without
 * needing its own <script> tag.
 *
 * Deliberately omits `offers` (pricing): PLANS pricing lives in
 * pricing/PricingTable.tsx and can change independently of this file. A
 * stale price in structured data is worse than no price at all — add
 * `offers` here only alongside a shared source of truth for plan pricing.
 */
export function OrganizationJsonLd({ appUrl }: { appUrl: string }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${appUrl}/#organization`,
        name: "Avise",
        url: appUrl,
        logo: `${appUrl}/favicon.svg`,
      },
      {
        "@type": "SoftwareApplication",
        name: "Avise",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description:
          "Deal flow software, institutional CRM, and AI-powered deal analysis for search funds, independent sponsors, and emerging private equity managers.",
        url: appUrl,
        publisher: { "@id": `${appUrl}/#organization` },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}
