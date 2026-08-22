import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WebVitals } from "@/components/WebVitals";
import { OrganizationJsonLd } from "@/components/OrganizationJsonLd";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Matches the fallback already used for absolute links elsewhere (see
// (app)/memo-builder/export.ts) — lmmos.ai is still the canonical domain
// per PROGRESS.md until the app.avise.io cutover finishes, so metadataBase
// tracks that instead of hardcoding a domain the cutover hasn't landed on.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://lmmos.ai";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Deal Flow Software for Search Funds & PE Deal Teams | Avise",
    template: "%s | Avise",
  },
  description: "AI-powered deal flow software, institutional CRM, and deal analysis for search funds, independent sponsors, and emerging PE managers.",
  keywords: [
    "deal flow software",
    "search fund software",
    "deal analysis software",
    "private equity CRM",
    "independent sponsor software",
  ],
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Deal Flow Software for Search Funds & PE Deal Teams | Avise",
    description: "Automate deal flow analysis and unify your institutional CRM with the world's first AI-native PE operating system.",
    type: "website",
    siteName: "Avise",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Deal Flow Software for Search Funds & PE Deal Teams | Avise",
    description: "AI-powered deal flow management for search funds and modern private equity firms.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased h-full`}>
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="h-full font-sans overflow-hidden">
        <OrganizationJsonLd appUrl={APP_URL} />
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
