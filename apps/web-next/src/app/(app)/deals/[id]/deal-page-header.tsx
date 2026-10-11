"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useUser } from "@/providers/UserProvider";
import { useAuth } from "@/providers/AuthProvider";
import { useToast } from "@/providers/ToastProvider";
import { getDealDisplayName } from "@/lib/formatters";
import { NotificationCenter } from "@/components/layout/NotificationPanel";

import {
  type DealDetail,
  TeamAvatarStack,
} from "./components";

// ---------------------------------------------------------------------------
// Header bar — breadcrumb (Deals > <DealName>) on the left; team avatar
// stack, Data Room link, share-link button, Edit Deal button, notifications,
// and user menu on the right.
//
// State for the user dropdown / link-copied flag is local to the header —
// page.tsx doesn't need it. helpOpen lives in page.tsx because the modal
// sits with the other modals.
// ---------------------------------------------------------------------------

export interface DealPageHeaderProps {
  deal: DealDetail;
  dealId: string;
  setShowEditModal: Dispatch<SetStateAction<boolean>>;
  setShowTeamModal: Dispatch<SetStateAction<boolean>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
}

export function DealPageHeader({
  deal,
  dealId,
  setShowEditModal,
  setShowTeamModal,
  setHelpOpen,
}: DealPageHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useUser();
  const { signOut } = useAuth();
  const { showToast } = useToast();

  const [linkCopied, setLinkCopied] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  // Close user dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userDropdownRef.current && !userDropdownRef.current.contains(e.target as Node)) {
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const initials =
    user?.name?.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-4 lg:px-6 bg-surface-card z-40 relative">
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <nav className="flex min-w-0 items-center gap-1.5 text-sm">
          <button
            onClick={() => router.back()}
            className="flex items-center justify-center size-7 rounded-md hover:bg-primary-light text-text-muted hover:text-primary transition-colors mr-1"
            title="Go back"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <Link href="/deals" className="text-text-muted hover:text-primary transition-colors">
            Deals
          </Link>
          <span className="material-symbols-outlined text-[14px] text-text-muted">chevron_right</span>
          <span className="text-text-main font-medium truncate max-w-[120px] lg:max-w-[300px]">
            {getDealDisplayName(deal)}
          </span>
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2 xl:gap-4">
        {/* Team Avatar Stack — click "+" or any avatar to open Manage Team */}
        <div
          className="hidden lg:flex items-center hover:opacity-90 transition-opacity"
          onClick={(e) => {
            // Only open from clicks on avatars; the explicit "+" button has
            // its own onClick passed via onManage.
            if ((e.target as HTMLElement).closest("button")) return;
            setShowTeamModal(true);
          }}
        >
          <TeamAvatarStack
            team={deal.team || []}
            onManage={() => setShowTeamModal(true)}
          />
        </div>

        <Link
          href={`/data-room/${dealId}`}
          title="Data Room"
          className="hidden md:flex items-center gap-2 px-2.5 xl:px-3 py-2 text-sm font-medium text-text-secondary hover:text-primary hover:bg-primary-light rounded-lg transition-colors border border-border-subtle"
        >
          <span className="material-symbols-outlined text-[18px]">folder_open</span>
          <span className="hidden xl:inline">Data Room</span>
        </Link>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.origin + pathname);
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 2000);
            } catch (err) {
              // clipboard API requires secure context — fall back to a toast hint
              console.warn("[deal] clipboard write failed:", err);
              showToast("Could not copy link — check your browser permissions", "warning");
            }
          }}
          className="hidden lg:flex items-center justify-center p-2 text-text-secondary hover:text-primary hover:bg-primary-light rounded-lg transition-colors"
          title="Copy share link"
        >
          <span className="material-symbols-outlined text-[20px]">{linkCopied ? "check" : "link"}</span>
        </button>
        <button
          onClick={() => setShowEditModal(true)}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap px-3 xl:px-4 py-2 text-sm font-medium text-white rounded-lg shadow-sm hover:bg-primary-hover transition-colors"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[18px]">edit_document</span>
          Edit Deal
        </button>

        {/* Divider */}
        <div className="h-6 w-px bg-border-subtle" />

        {/* Notification bell */}
        <NotificationCenter />

        {/* Divider */}
        <div className="h-6 w-px bg-border-subtle" />

        {/* User menu */}
        <div className="relative" ref={userDropdownRef}>
          <button
            onClick={() => setUserDropdownOpen(!userDropdownOpen)}
            className="flex items-center gap-2 text-sm font-medium text-text-main hover:text-primary transition-colors"
            title="Profile & Settings"
          >
            <div
              className="bg-center bg-no-repeat bg-cover rounded-full size-8 border border-gray-200 shadow-sm flex items-center justify-center bg-primary text-white text-xs font-bold"
              style={user?.avatar ? { backgroundImage: `url('${encodeURI(user.avatar)}')` } : {}}
            >
              {initials}
            </div>
            <span className="hidden xl:inline">{user?.name || "Loading..."}</span>
            <span
              className={`material-symbols-outlined text-[18px] text-text-muted transition-transform duration-200 ${
                userDropdownOpen ? "rotate-180" : ""
              }`}
            >
              expand_more
            </span>
          </button>

          {userDropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 rounded-lg shadow-lg py-1 z-50 bg-surface-card border border-border-subtle dropdown-animate">
              <div className="px-4 py-3 border-b border-border-subtle">
                <p className="text-sm font-medium text-text-main">{user?.name}</p>
                <p className="text-xs text-text-muted truncate">{user?.role}</p>
              </div>
              <div className="py-1">
                <Link
                  href="/settings"
                  className="user-dropdown-item flex items-center gap-3 px-4 py-2 text-sm text-text-secondary transition-colors"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  <span className="material-symbols-outlined text-[18px]">person</span>
                  Profile
                </Link>
                <Link
                  href="/settings"
                  className="user-dropdown-item flex items-center gap-3 px-4 py-2 text-sm text-text-secondary transition-colors"
                  onClick={() => setUserDropdownOpen(false)}
                >
                  <span className="material-symbols-outlined text-[18px]">settings</span>
                  Settings
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setUserDropdownOpen(false);
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
    </header>
  );
}
