"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "./Logo";

export function LandingNavbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[#f0f2f4] bg-white/80 backdrop-blur-md">
      <div className="px-4 md:px-10 lg:px-40 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Logo className="size-8 text-primary" />
          <h2 className="text-lg font-bold leading-tight tracking-[-0.015em] text-[#111418]">Avise</h2>
        </div>
        <nav className="hidden lg:flex items-center gap-8">
          <a className="text-sm font-medium text-primary" href="#features">Platform</a>
          <Link className="text-sm font-medium hover:text-primary transition-colors" href="/solutions">Solutions</Link>
          <Link className="text-sm font-medium hover:text-primary transition-colors" href="/resources">Resources</Link>
          <Link className="text-sm font-medium hover:text-primary transition-colors" href="/company">Company</Link>
        </nav>
        <div className="flex items-center gap-4">
          <Link href="/login" className="hidden sm:block text-sm font-medium text-slate-600 hover:text-primary transition-colors">Login</Link>
          <Link href="/signup" className="hidden sm:flex h-9 items-center justify-center rounded-lg px-4 text-white text-sm font-bold hover:opacity-90 transition-colors" style={{ backgroundColor: "#003366" }}>
            Get Started
          </Link>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden p-2 text-gray-600 hover:text-primary transition-colors"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            <span className="material-symbols-outlined">{mobileOpen ? "close" : "menu"}</span>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-[#f0f2f4] bg-white px-4 py-4 flex flex-col gap-3 animate-[slideDown_0.2s_ease-out]">
          <a className="text-sm font-medium text-text-main hover:text-primary py-2" href="#features" onClick={() => setMobileOpen(false)}>Platform</a>
          <Link className="text-sm font-medium text-text-main hover:text-primary py-2" href="/solutions" onClick={() => setMobileOpen(false)}>Solutions</Link>
          <Link className="text-sm font-medium text-text-main hover:text-primary py-2" href="/resources" onClick={() => setMobileOpen(false)}>Resources</Link>
          <Link className="text-sm font-medium text-text-main hover:text-primary py-2" href="/company" onClick={() => setMobileOpen(false)}>Company</Link>
          <div className="flex flex-col gap-2 pt-3 border-t border-[#f0f2f4]">
            <Link href="/login" className="text-sm font-medium text-slate-600 hover:text-primary py-2" onClick={() => setMobileOpen(false)}>Login</Link>
            <Link href="/signup" className="flex h-10 items-center justify-center rounded-lg text-white text-sm font-bold" style={{ backgroundColor: "#003366" }} onClick={() => setMobileOpen(false)}>
              Get Started
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
