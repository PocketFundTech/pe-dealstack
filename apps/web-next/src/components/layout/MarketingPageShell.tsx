import Link from "next/link";
import { Logo } from "./Logo";

export type MarketingPageSlug =
  | "pricing"
  | "documentation"
  | "api-reference"
  | "help-center"
  | "solutions"
  | "resources"
  | "company";

/**
 * Wider marketing-page shell used by /pricing, /documentation, /api-reference,
 * /help-center, /solutions, /resources, /company. Provides a slim header (logo
 * + nav links + login/signup) and a footer with cross-links to the legal pages.
 * Used for anonymous-visitor marketing surfaces — sibling to LegalPageShell
 * which is narrower and styled for legal copy.
 */
export function MarketingPageShell({
  active,
  children,
}: {
  active: MarketingPageSlug;
  children: React.ReactNode;
}) {
  const navLinks: Array<{ href: string; label: string; slug: MarketingPageSlug | "platform" }> = [
    { href: "/", label: "Platform", slug: "platform" },
    { href: "/solutions", label: "Solutions", slug: "solutions" },
    { href: "/resources", label: "Resources", slug: "resources" },
    { href: "/company", label: "Company", slug: "company" },
  ];

  return (
    // Root <body> has overflow-hidden for the (app) shell, so marketing
    // pages need their own scroll container — same pattern as
    // (auth)/layout.tsx, (onboarding)/layout.tsx, and the landing page.
    // Sticky header below stays pinned because it's sticky inside this
    // scroll ancestor.
    <div
      className="bg-[#f8fafc] text-[#111418] font-sans antialiased flex flex-col overflow-y-auto"
      style={{ height: "100vh" }}
    >
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-[#e5e7eb] bg-white/90 backdrop-blur-md">
        <div className="px-4 md:px-10 lg:px-20 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Logo className="size-8 text-primary" />
            <h2 className="text-lg font-bold leading-tight tracking-[-0.015em] text-[#111418]">
              PE OS
            </h2>
          </Link>
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => {
              const isActive = link.slug === active;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    isActive
                      ? "text-primary text-sm font-medium leading-normal"
                      : "text-[#111418] text-sm font-medium leading-normal hover:text-primary transition-colors"
                  }
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden sm:flex h-9 min-w-[84px] items-center justify-center rounded-lg px-4 border border-[#d1d5db] text-[#111418] text-sm font-bold hover:bg-gray-50 transition-colors"
            >
              Log In
            </Link>
            <Link
              href="/signup"
              className="flex h-9 min-w-[84px] items-center justify-center rounded-lg px-4 text-white text-sm font-bold hover:opacity-90 transition-colors shadow-sm"
              style={{ backgroundColor: "#003366" }}
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="border-t border-[#e5e7eb] bg-white py-12 px-6 md:px-10">
        <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <Logo className="size-6 text-primary" />
            <span className="text-sm font-medium text-[#64748b]">
              &copy; 2026 PE OS. All rights reserved.
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-6">
            <Link href="/privacy-policy" className="text-sm text-[#64748b] hover:text-primary transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms-of-service" className="text-sm text-[#64748b] hover:text-primary transition-colors">
              Terms of Service
            </Link>
            <Link href="/security" className="text-sm text-[#64748b] hover:text-primary transition-colors">
              Security
            </Link>
            <a href="mailto:hello@pocket-fund.com" className="text-sm text-[#64748b] hover:text-primary transition-colors">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
