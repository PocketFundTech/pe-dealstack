"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/providers/UserProvider";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SecuritySection } from "./SecuritySection";
import { type PrefsState } from "./PreferencesSection";
import { ProfileSection, type UserProfile } from "./ProfileSection";
import { NotificationsSection, DEFAULT_NOTIFICATION_PREFS } from "./NotificationsSection";
import { TeamSection } from "./TeamSection";
import { FirmContextSection } from "./FirmContextSection";
import { FirmProfileSection } from "./FirmProfileSection";
import { CriteriaSection } from "./CriteriaSection";
import { FirmTeaserSection } from "./FirmTeaserSection";
import { AiUsageSection } from "./AiUsageSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { NDATemplatesSection } from "./NDATemplatesSection";

// ─── Constants ──────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: "general", label: "General", icon: "person" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "notifications", label: "Notifications", icon: "notifications" },
  { id: "team", label: "Team", icon: "group" },
  { id: "firm-context", label: "Firm Context", icon: "menu_book" },
  { id: "firm-profile", label: "Firm Profile", icon: "domain" },
  { id: "criteria", label: "Investment Criteria", icon: "grading" },
  { id: "firm-teaser", label: "Firm Teaser", icon: "auto_awesome" },
  { id: "integrations", label: "Integrations", icon: "extension" },
  { id: "ai-usage", label: "AI Usage", icon: "analytics" },
] as const;

const DEFAULT_PREFS: PrefsState = {
  investmentFocus: [],
  preferredCurrency: "USD",
  density: "default",
  theme: "light",
};

// ─── Helpers ────────────────────────────────────────────────────────

function parsePrefs(raw: UserProfile["preferences"]): {
  prefs: PrefsState;
  notifications: Record<string, boolean>;
} {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      console.warn("[settings] failed to parse preferences JSON:", err);
      obj = {};
    }
  } else if (raw && typeof raw === "object") {
    obj = raw;
  }
  const prefs: PrefsState = {
    investmentFocus: Array.isArray(obj.investmentFocus) ? (obj.investmentFocus as string[]) : [],
    preferredCurrency: typeof obj.preferredCurrency === "string" ? obj.preferredCurrency : "USD",
    density: typeof obj.density === "string" ? obj.density : "default",
    theme: typeof obj.theme === "string" ? obj.theme : "light",
  };
  const notifsRaw = obj.notifications;
  const notifications =
    notifsRaw && typeof notifsRaw === "object"
      ? { ...DEFAULT_NOTIFICATION_PREFS, ...(notifsRaw as Record<string, boolean>) }
      : DEFAULT_NOTIFICATION_PREFS;
  return { prefs, notifications };
}

// ─── Page ───────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { refetch: refetchUser } = useUser();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [activeSection, setActiveSection] = useState<string>("general");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULT_PREFS);
  const [notificationPrefs, setNotificationPrefs] = useState<Record<string, boolean>>(
    DEFAULT_NOTIFICATION_PREFS,
  );

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const markChanged = () => setHasChanges(true);

  const applyProfile = useCallback((data: UserProfile) => {
    setProfile(data);
    setName(data.name || "");
    setTitle(data.title || "");
    const { prefs: parsed, notifications } = parsePrefs(data.preferences);
    setPrefs(parsed);
    setNotificationPrefs(notifications);
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const data = await api.get<UserProfile>("/users/me");
      applyProfile(data);
    } catch (err) {
      console.warn("[settings] load failed:", err);
      showToast(err instanceof Error ? err.message : "Failed to load profile", "error");
    } finally {
      setLoading(false);
    }
  }, [applyProfile, showToast]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Observe sections to highlight the active nav link while scrolling
  useEffect(() => {
    const sectionIds = NAV_SECTIONS.map((s) => `section-${s.id}`);
    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const id = visible.target.id.replace("section-", "");
          setActiveSection(id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [loading]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        title: title.trim(),
        preferences: {
          ...prefs,
          notifications: notificationPrefs,
        },
      };
      const updated = await api.patch<UserProfile>("/users/me", payload);
      applyProfile(updated);
      setHasChanges(false);
      showToast("Changes saved successfully", "success");
      refetchUser();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save changes", "error");
    } finally {
      setSaving(false);
    }
  };

  const [confirmAction, setConfirmAction] = useState<"discard" | "deactivate" | null>(null);

  const handleCancel = () => {
    if (!hasChanges) return;
    setConfirmAction("discard");
  };

  const handleDeactivate = () => {
    setConfirmAction("deactivate");
  };

  const executeConfirm = () => {
    if (confirmAction === "discard") {
      if (profile) applyProfile(profile);
      setHasChanges(false);
    } else if (confirmAction === "deactivate") {
      showToast("Account deactivation is not available in this version", "error");
    }
    setConfirmAction(null);
  };

  const updatePrefs = (patch: Partial<PrefsState>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
    markChanged();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center text-text-muted">
          <span className="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
          <p className="mt-2 text-sm">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] w-full p-4 md:p-6">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed top-4 right-4 z-[60] flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all border",
            toast.type === "success"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200",
          )}
        >
          <span className="material-symbols-outlined text-[18px]">
            {toast.type === "success" ? "check_circle" : "error"}
          </span>
          {toast.message}
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm text-text-muted mb-1">
            <Link href="/dashboard" className="hover:text-primary transition-colors">
              Dashboard
            </Link>
            <span className="material-symbols-outlined text-[16px]">chevron_right</span>
            <span className="text-text-main font-medium">Settings</span>
          </div>
          <h1 className="text-2xl font-bold text-text-main tracking-tight">
            User Profile &amp; Personalization
          </h1>
          <p className="text-text-secondary text-sm">
            Configure your professional identity and tune the platform&apos;s AI behavior.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleCancel}
            disabled={!hasChanges}
            className="px-4 py-2 bg-white border border-border-subtle text-text-main text-sm font-semibold rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors shadow-card disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="px-5 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-lg shadow-card transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {saving && (
              <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
            )}
            Save Changes
          </button>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 shrink-0">
          <nav className="sticky top-6 flex flex-col gap-1">
            {NAV_SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <a
                  key={section.id}
                  href={`#section-${section.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const target = document.getElementById(`section-${section.id}`);
                    if (target) {
                      target.scrollIntoView({ behavior: "smooth", block: "start" });
                      history.replaceState(null, "", `#${section.id}`);
                    }
                    setActiveSection(section.id);
                  }}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg border transition-all",
                    isActive
                      ? "bg-primary-light text-primary border-primary"
                      : "border-transparent text-text-secondary hover:bg-primary-light hover:text-primary",
                  )}
                >
                  <span
                    className="material-symbols-outlined text-[18px]"
                    style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                  >
                    {section.icon}
                  </span>
                  <span className="text-sm font-medium">{section.label}</span>
                </a>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 flex flex-col gap-6 min-w-0">
          <ProfileSection
            profile={profile}
            name={name}
            setName={setName}
            title={title}
            setTitle={setTitle}
            onAvatarUploaded={(updated) => {
              applyProfile(updated);
              refetchUser();
            }}
            onToast={showToast}
            markChanged={markChanged}
          />

          <SecuritySection onToast={showToast} />

          {/* Preferences section hidden for now */}

          <NotificationsSection
            notificationPrefs={notificationPrefs}
            setNotificationPrefs={setNotificationPrefs}
            markChanged={markChanged}
          />

          <TeamSection onToast={showToast} />

          <FirmContextSection />

          <FirmProfileSection />

          <CriteriaSection />

          <FirmTeaserSection />

          <IntegrationsSection onToast={showToast} />

          <NDATemplatesSection />

          <AiUsageSection />

          {/* Deactivate Account */}
          <div className="flex items-center justify-between p-4 bg-red-50 border border-red-200 rounded-lg">
            <div>
              <h4 className="text-sm font-bold text-red-700">Deactivate Professional Account</h4>
              <p className="text-xs text-red-600/80">
                Temporarily disable your analyst profile and data access.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDeactivate}
              className="px-4 py-2 bg-white border border-red-200 text-red-600 text-xs font-bold rounded-lg hover:bg-red-50 transition-colors shadow-sm"
            >
              Deactivate
            </button>
          </div>

          {hasChanges && (
            <div className="text-xs text-amber-600 font-medium flex items-center gap-1.5 justify-end">
              <span className="material-symbols-outlined text-[14px]">info</span>
              You have unsaved changes — click Save Changes at the top.
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction === "deactivate" ? "Deactivate Account" : "Discard Changes"}
        message={
          confirmAction === "deactivate"
            ? "Are you sure you want to deactivate your account? This will disable your profile and data access."
            : "Discard all unsaved changes? This cannot be undone."
        }
        confirmLabel={confirmAction === "deactivate" ? "Deactivate" : "Discard"}
        variant={confirmAction === "deactivate" ? "danger" : "default"}
        onConfirm={executeConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
