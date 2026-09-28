"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/providers/AuthProvider";
import { useUser } from "@/providers/UserProvider";
import { useIngestDealModal } from "@/providers/IngestDealModalProvider";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NotificationCenter } from "./NotificationPanel";

// Ported from onboarding-config.js (f23a61c).
// Hardcoded here for now — web-next doesn't yet have a runtime config layer.
const SUPPORT_CONFIG = {
  bookingUrl: "https://calendar.app.google/vRexQ5AmhivWx2PH6",
  formUrl: "https://docs.google.com/forms/d/e/1FAIpQLSet_GfebuKpdspK7aQ8yAFUF_l5yXeFczBRoKauGEg2GlpS5g/viewform",
  urgentEmails: ["tech@pocketfund.org", "hello@pocketfund.org"],
} as const;

export function Header() {
  const { signOut } = useAuth();
  const { user } = useUser();
  const { openDealIntake } = useIngestDealModal();
  const pathname = usePathname();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const showDealActions = pathname === "/deals";
  const isDealDetailPage = /^\/deals\/[^/]+$/.test(pathname);
  const isDataRoomPage = pathname === "/data-room" || /^\/data-room\/[^/]/.test(pathname);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const initials = user?.name?.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "";

  // Deal detail pages and data-room pages render their own full-width header
  // that already includes breadcrumbs, actions, and user menu.
  // Returning null here avoids the double-header effect.
  if (isDealDetailPage || isDataRoomPage) return null;

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-border-subtle px-4 md:px-6 bg-surface-card z-40 sticky top-0 min-w-0">
      <div className="flex items-center gap-4 flex-1">
        {/* Breadcrumb nav — shown on pages that have a known parent context */}
        {pathname === "/deals" && (
          <nav className="hidden md:flex items-center gap-1.5 text-sm mr-4 shrink-0">
            <Link href="/dashboard" className="text-text-muted hover:text-primary transition-colors">
              Dashboard
            </Link>
            <span className="material-symbols-outlined text-[14px] text-text-muted">chevron_right</span>
            <span className="text-text-main font-medium">Deals</span>
          </nav>
        )}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="relative w-full max-w-lg items-center rounded-md border border-border-subtle bg-background-body py-2 pl-10 pr-10 text-sm text-text-muted cursor-pointer hover:border-primary/40 transition-all shadow-sm text-left hidden md:flex"
        >
          <div className="absolute inset-y-0 left-0 flex items-center pl-3">
            <span className="material-symbols-outlined text-text-muted text-[20px]">
              search
            </span>
          </div>
          <span>Search deals, pages, and actions...</span>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 gap-1">
            <kbd className="px-1.5 py-0.5 text-[10px] font-bold text-gray-400 bg-gray-100 rounded border border-gray-200">
              &#8984;K
            </kbd>
          </div>
        </button>
      </div>

      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        {showDealActions && (
          <div className="hidden sm:flex items-center gap-2 md:gap-4">
            {/* Bulk CSV import modal hasn't been ported from legacy crm.html yet —
                keep the Import button hidden so we don't 404 users. Port tracked
                in docs/planning/WEB-NEXT-PORT-PLAN.md. */}
            <button
              type="button"
              onClick={() => openDealIntake()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-white rounded-lg shadow-sm hover:bg-[#002855] transition-colors text-sm font-medium"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-[16px]">smart_toy</span>
              Ingest Deal Data
            </button>
          </div>
        )}

        {/* Notifications — slide-out panel */}
        <NotificationCenter />

        <div className="h-6 w-px bg-border-subtle" />

        {/* User menu */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 text-sm font-medium text-text-main hover:text-primary transition-colors"
            title="Profile & Settings"
          >
            <div
              className="bg-center bg-no-repeat bg-cover rounded-full size-8 border border-gray-200 shadow-sm flex items-center justify-center bg-primary text-white text-xs font-bold"
              style={user?.avatar ? { backgroundImage: `url('${encodeURI(user.avatar)}')` } : {}}
            >
              {initials}
            </div>
            <span className="hidden md:inline">{user?.name || "Loading..."}</span>
            <span
              className={`material-symbols-outlined text-[18px] text-text-muted transition-transform duration-200 ${
                dropdownOpen ? "rotate-180" : ""
              }`}
            >
              expand_more
            </span>
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 rounded-lg shadow-lg py-1 z-50 bg-surface-card border border-border-subtle dropdown-animate">
              <div className="px-4 py-3 border-b border-border-subtle">
                <p className="text-sm font-medium text-text-main">{user?.name}</p>
                <p className="text-xs text-text-muted truncate">{user?.role}</p>
              </div>
              <div className="py-1">
                <Link
                  href="/settings"
                  className="user-dropdown-item flex items-center gap-3 px-4 py-2 text-sm text-text-secondary transition-colors"
                  onClick={() => setDropdownOpen(false)}
                >
                  <span className="material-symbols-outlined text-[18px]">person</span>
                  Profile
                </Link>
                <Link
                  href="/settings"
                  className="user-dropdown-item flex items-center gap-3 px-4 py-2 text-sm text-text-secondary transition-colors"
                  onClick={() => setDropdownOpen(false)}
                >
                  <span className="material-symbols-outlined text-[18px]">settings</span>
                  Settings
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setDropdownOpen(false);
                    setHelpOpen(true);
                  }}
                  className="user-dropdown-item flex items-center gap-3 px-4 py-2 text-sm w-full text-left text-text-secondary transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">help</span>
                  Help &amp; Support
                </button>
              </div>
              <div className="border-t border-border-subtle py-1">
                <button
                  onClick={signOut}
                  className="user-dropdown-item-logout flex items-center gap-3 px-4 py-2 text-sm w-full text-left text-red-600 transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">logout</span>
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <HelpSupportModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}

// ---------------------------------------------------------------------------
// HelpSupportModal
// Two-option modal opened from the user dropdown (Book a Call / Written
// Feedback), with urgent-contact mailto footer. Ported from
// layoutComponents.js generateHelpSupportModal (f23a61c).
// ---------------------------------------------------------------------------

export function HelpSupportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center backdrop-blur-md"
      data-modal-overlay
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden bg-surface-card border border-border-subtle">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-border-subtle bg-background-body">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: "#003366" }}>
              <span className="material-symbols-outlined text-white text-[20px]">help</span>
            </div>
            <div>
              <h3 className="text-base font-bold text-text-main">Help &amp; Support</h3>
              <p className="text-xs text-text-muted">Choose how you&apos;d like to reach our team.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-text-muted hover:bg-background-body transition-colors"
            title="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Options */}
        <div className="p-6 space-y-3">
          <HelpOptionCard
            icon="event"
            title="Book a Support Call"
            desc="30-min video call with our team. Pick a time that works for you."
            onClick={() => openExternal(SUPPORT_CONFIG.bookingUrl)}
          />
          <HelpOptionCard
            icon="edit_note"
            title="Send Written Feedback"
            desc="Quick form for bug reports, feature requests, or general feedback."
            onClick={() => openExternal(SUPPORT_CONFIG.formUrl)}
          />
        </div>

        {/* Footer — urgent emails */}
        <div className="px-6 py-3 text-center border-t border-border-subtle bg-background-body">
          <p className="text-xs text-text-muted">
            Need urgent help? Email{" "}
            {SUPPORT_CONFIG.urgentEmails.map((email, i) => (
              <span key={email}>
                <a
                  href={`mailto:${email}`}
                  className="font-semibold"
                  style={{ color: "#003366" }}
                >
                  {email}
                </a>
                {i < SUPPORT_CONFIG.urgentEmails.length - 1 ? " or " : ""}
              </span>
            ))}
          </p>
        </div>
      </div>
    </div>
  );
}

function HelpOptionCard({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: string;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg flex items-start gap-4 transition-all hover:shadow-md bg-surface-card border-[1.5px] border-border-subtle hover:border-primary hover:bg-[#F8FAFC]"
    >
      <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: "#E6EEF5", color: "#003366" }}>
        <span className="material-symbols-outlined text-[22px]">{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-text-main">{title}</p>
        <p className="text-xs mt-0.5 text-text-muted">{desc}</p>
      </div>
      <span className="material-symbols-outlined text-[20px] shrink-0 text-text-muted">chevron_right</span>
    </button>
  );
}
