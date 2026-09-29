import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WebVitals } from "@/components/WebVitals";
import { ICON_FONT_URL } from "@/lib/iconFont";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "Avise — Private Equity Operating System",
    template: "%s | Avise",
  },
  description: "AI-powered deal flow management, institutional CRM, and portfolio intelligence for modern Private Equity firms.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Avise — Private Equity Operating System",
    description: "Automate deal flow analysis and unify your institutional CRM with the world's first AI-native PE operating system.",
    type: "website",
    siteName: "Avise",
  },
  twitter: {
    card: "summary_large_image",
    title: "Avise — Private Equity Operating System",
    description: "AI-powered deal flow management for modern Private Equity firms.",
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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={ICON_FONT_URL} />
      </head>
      <body className="h-full font-sans overflow-hidden">
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
