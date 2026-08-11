import Link from "next/link";
import { Logo } from "./Logo";

/**
 * Minimal public-page shell used by /privacy-policy, /terms-of-service, and
 * /security. Provides a slim header (logo + back-to-home + login/signup) and
 * a footer that cross-links the other public legal/trust pages. No
 * authenticated sidebar or provider context — these pages render for
 * anonymous visitors arriving from the signup consent links or the trust
 * page link sent by sales.
 */
export function LegalPageShell({
  title,
  lastUpdated,
  activeFooterLink,
  maxWidth = "3xl",
  children,
}: {
  title: string;
  lastUpdated: string;
  activeFooterLink: "privacy" | "terms" | "security";
  maxWidth?: "3xl" | "4xl";
  children: React.ReactNode;
}) {
  const contentMaxWidth = maxWidth === "4xl" ? "max-w-4xl" : "max-w-3xl";
  return (
    <div
      className="bg-[#f8fafc] text-[#1e293b] font-sans overflow-x-hidden overflow-y-auto antialiased"
      style={{ height: "100vh" }}
    >
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-[#f0f2f4] bg-white/80 backdrop-blur-md">
        <div className="px-4 md:px-10 lg:px-20 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Logo className="size-8 text-primary" />
            <h2 className="text-lg font-bold leading-tight tracking-[-0.015em] text-[#111418]">
              PE OS
            </h2>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="hidden sm:inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
              Back to home
            </Link>
            <Link
              href="/login"
              className="hidden sm:block text-sm font-medium text-slate-600 hover:text-primary transition-colors"
            >
              Log In
            </Link>
            <Link
              href="/signup"
              className="flex h-9 items-center justify-center rounded-lg px-4 text-white text-sm font-bold hover:opacity-90 transition-colors"
              style={{ backgroundColor: "#003366" }}
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="min-h-[calc(100vh-200px)]">
        <div className={`${contentMaxWidth} mx-auto px-6 py-16 lg:py-20`}>
          <div className="mb-12">
            <h1 className="text-4xl lg:text-5xl font-extrabold text-[#111418] mb-4 tracking-tight">
              {title}
            </h1>
            <p className="text-slate-500 text-lg">Last updated: {lastUpdated}</p>
          </div>
          <div className="space-y-10">{children}</div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-10 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <Logo className="size-6 text-primary" />
            <span className="text-sm font-medium text-slate-500">
              &copy; 2026 PE OS. All rights reserved.
            </span>
          </div>
          <div className="flex gap-6 text-sm">
            <Link
              href="/privacy-policy"
              className={
                activeFooterLink === "privacy"
                  ? "text-primary font-semibold"
                  : "text-slate-500 hover:text-primary transition-colors"
              }
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms-of-service"
              className={
                activeFooterLink === "terms"
                  ? "text-primary font-semibold"
                  : "text-slate-500 hover:text-primary transition-colors"
              }
            >
              Terms of Service
            </Link>
            <Link
              href="/security"
              className={
                activeFooterLink === "security"
                  ? "text-primary font-semibold"
                  : "text-slate-500 hover:text-primary transition-colors"
              }
            >
              Security
            </Link>
            <a
              href="mailto:hello@pocket-fund.com"
              className="text-slate-500 hover:text-primary transition-colors"
            >
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Section heading used by legal pages — h2 with consistent typography. */
export function LegalH2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-bold text-[#111418] mb-4 tracking-tight">
      {children}
    </h2>
  );
}

/** Sub-section heading — h3. */
export function LegalH3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xl font-semibold text-[#111418] mb-3 mt-6">
      {children}
    </h3>
  );
}

/** Body paragraph for legal copy. */
export function LegalP({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-600 leading-relaxed mb-4">{children}</p>;
}

/** Bulleted list for legal copy. */
export function LegalList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="list-disc list-inside text-slate-600 space-y-2 mb-4">
      {children}
    </ul>
  );
}
