"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/providers/ToastProvider";
import { useUser } from "@/providers/UserProvider";
import { api } from "@/lib/api";
import { useApiQuery, mutateApiCache } from "@/lib/useApiQuery";
import { cn } from "@/lib/cn";
import { OUTREACH_ALLOWED_ORG_SLUGS } from "@/lib/constants";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import { USERS_ME_KEY } from "./settings-api-keys";
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
import { ApiKeysSection } from "./ApiKeysSection";
import { WebhooksSection } from "./WebhooksSection";
import { NDATemplatesSection } from "./NDATemplatesSection";
import { OutreachPipelineSection } from "./OutreachPipelineSection";

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
  { id: "api-keys", label: "API Keys", icon: "key" },
  { id: "webhooks", label: "Webhooks", icon: "webhook" },
  { id: "ai-usage", label: "AI Usage", icon: "analytics" },
  { id: "outreach-pipeline", label: "Outreach Pipeline", icon: "campaign" },
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
  const { user, refetch: refetchUser } = useUser();
  // Outreach Pipeline settings only apply to orgs allowed to use Outreach at
  // all — re-check here the same way apps/outreach/page.tsx and the sidebar
  // (Sidebar.tsx's orgSlugAllowlist filter) do, so this section is never
  // shown to orgs that can't even see the Outreach tab.
  const showOutreachPipeline = OUTREACH_ALLOWED_ORG_SLUGS.includes(
    user?.organization?.slug ?? "",
  );
  const visibleSections = useMemo(
    () => NAV_SECTIONS.filter((s) => s.id !== "outreach-pipeline" || showOutreachPipeline),
    [showOutreachPipeline],
  );
  // Shared with FirmProfileSection, which reads the same /users/me endpoint
  // for org-settings fields -- useApiQuery dedupes the two into one request
  // instead of two. See settings-api-keys.ts.
  const usersMeQuery = useApiQuery<UserProfile>(USERS_ME_KEY);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  useUnsavedChanges(hasChanges);
  const [activeSection, setActiveSection] = useState<string>("general");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [prefs, setPrefs] = useState<PrefsState>(DEFAULT_PREFS);
  const [notificationPrefs, setNotificationPrefs] = useState<Record<string, boolean>>(
    DEFAULT_NOTIFICATION_PREFS,
  );

  // App-wide toasts: supports info, and a newer toast is never dismissed by an
  // older toast's timer (the page's own toast state had both problems).
  const { showToast } = useToast();

  const markChanged = () => setHasChanges(true);

  const applyProfile = useCallback((data: UserProfile) => {
    setProfile(data);
    setName(data.name || "");
    setTitle(data.title || "");
    const { prefs: parsed, notifications } = parsePrefs(data.preferences);
    setPrefs(parsed);
    setNotificationPrefs(notifications);
  }, []);

  // Editable fields (name/title/prefs/notificationPrefs) are seeded from
  // /users/me exactly once per mount -- same as the old one-shot loadProfile
  // -- so a background revalidation of the shared cache entry (e.g. because
  // FirmProfileSection or another tab refetched it) never clobbers text the
  // user is mid-typing. `profile` itself (read-only display data + the
  // Cancel-to-last-saved snapshot) is likewise only synced on that first
  // load and after an explicit save.
  const appliedInitialProfile = useRef(false);
  useEffect(() => {
    if (appliedInitialProfile.current) return;
    if (usersMeQuery.data) {
      applyProfile(usersMeQuery.data);
      appliedInitialProfile.current = true;
    } else if (usersMeQuery.error) {
      console.warn("[settings] load failed:", usersMeQuery.error);
      showToast(usersMeQuery.error.message || "Failed to load profile", "error");
      appliedInitialProfile.current = true;
    }
  }, [usersMeQuery.data, usersMeQuery.error, applyProfile, showToast]);

  const loading = usersMeQuery.isLoading;

  // Observe sections to highlight the active nav link while scrolling
  useEffect(() => {
    const sectionIds = visibleSections.map((s) => `section-${s.id}`);
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
  }, [loading, visibleSections]);

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
      // Keep the shared /users/me cache entry in sync so FirmProfileSection
      // (and any other reader) sees the save without an extra fetch.
      mutateApiCache(USERS_ME_KEY, updated);
      setHasChanges(false);
      showToast("Changes saved successfully", "success");
      refetchUser();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save changes", "error");
    } finally {
      setSaving(false);
    }
  };

  const [confirmAction, setConfirmAction] = useState<"discard" | null>(null);

  const handleCancel = () => {
    if (!hasChanges) return;
    setConfirmAction("discard");
  };

  const executeConfirm = () => {
    if (confirmAction === "discard") {
      if (profile) applyProfile(profile);
      setHasChanges(false);
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
            {visibleSections.map((section) => {
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
              mutateApiCache(USERS_ME_KEY, updated);
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

          <ApiKeysSection onToast={showToast} />

          <WebhooksSection onToast={showToast} />

          <NDATemplatesSection />

          <AiUsageSection />

          {showOutreachPipeline && <OutreachPipelineSection />}

          {/* QA #16: "Deactivate account" was a stub (confirm → "not available"
              toast). Hidden until self-deactivation is built; admins can still
              deactivate a user (DELETE /api/users/:id, which sets isActive=false). */}

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
        title="Discard Changes"
        message="Discard all unsaved changes? This cannot be undone."
        confirmLabel="Discard"
        variant="default"
        onConfirm={executeConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
