import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { WebVitals } from "@/components/WebVitals";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "PE OS — Private Equity Operating System",
    template: "%s | PE OS",
  },
  description: "AI-powered deal flow management, institutional CRM, and portfolio intelligence for modern Private Equity firms.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "PE OS — Private Equity Operating System",
    description: "Automate deal flow analysis and unify your institutional CRM with the world's first AI-native PE operating system.",
    type: "website",
    siteName: "PE OS",
  },
  twitter: {
    card: "summary_large_image",
    title: "PE OS — Private Equity Operating System",
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
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="h-full font-sans overflow-hidden">
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
