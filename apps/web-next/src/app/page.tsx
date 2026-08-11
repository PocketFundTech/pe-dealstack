import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { LandingNavbar } from "@/components/layout/LandingNavbar";

export default function LandingPage() {
  // The root body has overflow-hidden for the (app) shell — wrap in a
  // 100vh scroll container so this long marketing page scrolls naturally.
  // Same pattern as (auth)/layout.tsx and (onboarding)/layout.tsx.
  return (
    <div
      className="bg-[#f8fafc] text-[#1e293b] font-sans overflow-x-hidden overflow-y-auto antialiased"
      style={{ height: "100vh" }}
    >
      {/* Navbar (client component for mobile menu interactivity) */}
      <LandingNavbar />

      {/* Hero */}
      <div className="relative w-full overflow-hidden bg-[#f8fafc]">
        {/* Grid pattern background matching legacy */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23003366' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")" }} />
        <div className="absolute top-0 right-0 -mr-20 -mt-20 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-80 h-80 bg-blue-400/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative px-4 md:px-10 lg:px-40 py-16 lg:py-24">
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col lg:flex-row gap-12 lg:gap-20 items-center">
              <div className="flex-1 flex flex-col gap-6 text-center lg:text-left z-10">
                <div className="inline-flex items-center gap-2 self-center lg:self-start rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
                  <span className="flex size-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs font-semibold text-primary uppercase tracking-wide">New: GPT-4o Integration</span>
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold leading-[1.1] tracking-tight text-[#111418]">
                  The Intelligence Layer for <span className="text-primary">Private Equity</span>
                </h1>
                <p className="text-lg text-slate-600 font-medium leading-relaxed max-w-2xl mx-auto lg:mx-0">
                  Automate deal flow analysis and unify your institutional CRM with the world&apos;s first AI-native PE operating system.
                </p>
                <div className="flex flex-wrap gap-4 justify-center lg:justify-start pt-4">
                  <Link href="/signup" className="h-12 px-8 rounded-lg text-white text-base font-bold shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all transform hover:-translate-y-0.5 flex items-center justify-center" style={{ backgroundColor: "#003366" }}>
                    Get Started Free
                  </Link>
                  <Link href="/documentation" className="h-12 px-8 rounded-lg bg-white border border-slate-200 text-[#111418] text-base font-bold hover:bg-slate-50 transition-colors flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px]">menu_book</span>
                    View Documentation
                  </Link>
                </div>
                <div className="flex items-center justify-center lg:justify-start gap-2 text-sm text-slate-500 pt-2">
                  <span className="material-symbols-outlined text-[18px] text-green-500">check_circle</span>
                  <span>SOC 2 Type II Compliant</span>
                </div>
              </div>
              {/* Hero Image / Dashboard Preview */}
              <div className="flex-1 w-full max-w-[600px] lg:max-w-none" style={{ perspective: "1000px" }}>
                <div className="relative group transform transition-transform duration-700 hover:scale-[1.01] hover:rotate-1">
                  {/* Glow effect behind */}
                  <div className="absolute -inset-1 bg-gradient-to-r from-primary to-blue-400 rounded-xl blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200" />
                  {/* Main Image Container */}
                  <div className="relative rounded-xl overflow-hidden shadow-2xl bg-white border border-slate-200">
                    <div className="absolute top-0 w-full h-8 bg-slate-100 border-b border-slate-200 flex items-center px-4 gap-2">
                      <div className="size-2.5 rounded-full bg-red-400" />
                      <div className="size-2.5 rounded-full bg-yellow-400" />
                      <div className="size-2.5 rounded-full bg-green-400" />
                    </div>
                    <div className="pt-8 aspect-[4/3]" style={{ background: "linear-gradient(135deg, #003366 0%, #004488 40%, #0055AA 70%, #1a6bb5 100%)" }}>
                      <div className="w-full h-full bg-white/10 backdrop-contrast-125 p-6 flex flex-col gap-4">
                        <div className="flex gap-4">
                          <div className="w-1/3 h-32 rounded bg-white/90 shadow-sm backdrop-blur" />
                          <div className="w-1/3 h-32 rounded bg-white/90 shadow-sm backdrop-blur" />
                          <div className="w-1/3 h-32 rounded bg-white/90 shadow-sm backdrop-blur" />
                        </div>
                        <div className="flex-1 rounded bg-white/90 shadow-sm backdrop-blur" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Features / Key Capabilities */}
      <div id="features" className="relative py-20 bg-[#f8fafc]">
        <div className="px-4 md:px-10 lg:px-40 max-w-7xl mx-auto">
          <div className="mb-16 text-center md:text-left md:flex md:items-end md:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-3xl md:text-4xl font-extrabold text-[#111418] tracking-tight mb-4">Key Capabilities</h2>
              <p className="text-lg text-slate-600">
                Streamline your investment operations with next-generation tools designed for the modern analyst.
              </p>
            </div>
            <div className="mt-6 md:mt-0">
              <Link className="text-primary font-bold hover:underline inline-flex items-center gap-1" href="/signup">
                View all features
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                icon: "view_in_ar",
                title: "AI-Driven Deal Ingestion",
                desc: "Instantly parse CIMs, Teasers, and NDAs into structured data. Our AI extracts key financial metrics and deal terms automatically.",
              },
              {
                icon: "chat_bubble",
                title: "Chat with Deals",
                desc: 'Query your entire deal history using natural language. Ask complex questions like "Show me SaaS deals with >$10M EBITDA from 2023."',
              },
              {
                icon: "hub",
                title: "Institutional CRM",
                desc: "Track relationships, intermediaries, and deal pipelines with automated updates. Syncs bi-directionally with Outlook and Gmail.",
              },
            ].map((f) => (
              <div key={f.title} className="group p-8 rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-primary/5 transition-all duration-300">
                <div className="size-14 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-6 group-hover:scale-110 transition-transform duration-300">
                  <span className="material-symbols-outlined text-3xl">{f.icon}</span>
                </div>
                <h3 className="text-xl font-bold text-[#111418] mb-3">{f.title}</h3>
                <p className="text-slate-600 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div id="cta" className="py-24 bg-white border-t border-slate-100">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#111418] mb-6">
            Ready to modernize your investment process?
          </h2>
          <p className="text-lg text-slate-600 mb-10 max-w-2xl mx-auto">
            Join over 200+ investment firms using PE OS to make data-driven decisions faster.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link href="/signup" className="h-14 px-8 rounded-lg text-white text-lg font-bold shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all flex items-center justify-center" style={{ backgroundColor: "#003366" }}>
              Start Your Free Trial
            </Link>
            <Link href="/signup?plan=enterprise" className="h-14 px-8 rounded-lg bg-white border border-slate-200 text-[#111418] text-lg font-bold hover:bg-slate-50 transition-colors flex items-center justify-center">
              Talk to Sales
            </Link>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-[#f8fafc] border-t border-slate-200 pt-16 pb-8">
        <div className="max-w-7xl mx-auto px-4 md:px-10 lg:px-40">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8 mb-12">
            <div className="col-span-2 lg:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <Logo className="size-6 text-primary" />
                <h2 className="text-lg font-bold text-[#111418]">PE OS</h2>
              </div>
              <p className="text-slate-500 text-sm leading-relaxed mb-6 max-w-xs">
                The operating system for the modern private equity firm. Intelligence, automation, and execution in one platform.
              </p>
              <div className="flex gap-4">
                <a className="text-slate-400 hover:text-primary transition-colors" href="https://linkedin.com" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><span className="material-symbols-outlined">public</span></a>
                <a className="text-slate-400 hover:text-primary transition-colors" href="mailto:contact@pe-os.com" aria-label="Email"><span className="material-symbols-outlined">alternate_email</span></a>
              </div>
            </div>
            <div>
              <h4 className="font-bold text-[#111418] mb-4">Product</h4>
              <ul className="flex flex-col gap-2 text-sm text-slate-500">
                <li><Link className="hover:text-primary transition-colors" href="/signup">Deal Flow</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/signup">CRM</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/signup">Intelligence</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/signup">Integrations</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold text-[#111418] mb-4">Company</h4>
              <ul className="flex flex-col gap-2 text-sm text-slate-500">
                <li><Link className="hover:text-primary transition-colors" href="/company">About Us</Link></li>
                <li><a className="hover:text-primary transition-colors" href="#cta">Careers</a></li>
                <li><a className="hover:text-primary transition-colors" href="#features">Blog</a></li>
                <li><a className="hover:text-primary transition-colors" href="#cta">Contact</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold text-[#111418] mb-4">Resources</h4>
              <ul className="flex flex-col gap-2 text-sm text-slate-500">
                <li><Link className="hover:text-primary transition-colors" href="/documentation">Documentation</Link></li>
                <li><Link className="hover:text-primary transition-colors" href="/api-reference">API Reference</Link></li>
                <li><a className="hover:text-primary transition-colors" href="#cta">Community</a></li>
                <li><Link className="hover:text-primary transition-colors" href="/help-center">Help Center</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-200 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-sm text-slate-400">&copy; 2026 PE OS. All rights reserved.</p>
            <div className="flex gap-6 text-sm text-slate-400">
              <Link className="hover:text-primary transition-colors" href="/privacy-policy">Privacy Policy</Link>
              <Link className="hover:text-primary transition-colors" href="/terms-of-service">Terms of Service</Link>
              <Link className="hover:text-primary transition-colors" href="/security">Security</Link>
              <a className="hover:text-primary transition-colors" href="#cta">Contact</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
