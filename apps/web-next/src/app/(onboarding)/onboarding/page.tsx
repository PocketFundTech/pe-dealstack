"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";
import { Logo } from "@/components/layout/Logo";
import { WelcomeView } from "./welcome-view";
import { ChecklistView } from "./checklist-view";
import { Confetti } from "./confetti";
import { FirmTaskModal } from "./firm-task";
import { CimTaskModal } from "./cim-task";
import { TeamTaskModal } from "./team-task";
import { SkipConfirmModal } from "./skip-modal";
import {
  FirmData,
  LEGACY_STEP_TO_TASK,
  OnboardingStatus,
  TASK_TO_LEGACY_STEP,
  TASKS,
  TaskId,
  TeamInvite,
} from "./types";

// Lenient URL normalization — backend Zod expects z.string().url() (must have
// scheme). Form lets users type "yourfirm.com" so prepend https:// if missing.
function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Main onboarding page — welcome view, then checklist of 3 tasks, then
// dashboard. Ported from onboarding-flow.js (3a796c8).
export default function OnboardingPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [view, setView] = useState<"welcome" | "checklist">("welcome");
  const [completed, setCompleted] = useState<Set<TaskId>>(new Set());
  const [activeTask, setActiveTask] = useState<TaskId | null>(null);
  const [showSkip, setShowSkip] = useState(false);

  const [firmData, setFirmData] = useState<FirmData>({ url: "", linkedin: "", aum: "", sectors: [] });
  const [sampleDealId, setSampleDealId] = useState<string | null>(null); // "wagoner" | null
  const [cimFile, setCimFile] = useState<File | null>(null);
  // Legacy starts with 2 team invite rows (onboarding-tasks.js team hydrator calls addRow() twice).
  const [teamInvites, setTeamInvites] = useState<TeamInvite[]>([
    { email: "", role: "Analyst" },
    { email: "", role: "Analyst" },
  ]);
  const [createdDealId, setCreatedDealId] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const confettiFiredRef = useRef(false);
  // Tracks which task is currently submitting (so modals can show loading state)
  const [busyTask, setBusyTask] = useState<TaskId | null>(null);

  // ─── Load existing progress from the API ────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<OnboardingStatus>("/onboarding/status");
        if (cancelled) return;
        const done = new Set<TaskId>();
        if (data.steps) {
          for (const [legacyId, isDone] of Object.entries(data.steps)) {
            if (!isDone) continue;
            const taskId = LEGACY_STEP_TO_TASK[legacyId];
            if (taskId) done.add(taskId);
          }
        }
        setCompleted(done);
        // If user already finished onboarding, skip straight to dashboard.
        if (done.size >= TASKS.length) router.push("/dashboard");
      } catch (err) {
        // Fresh user or API down — proceed with empty state. Don't toast;
        // an empty checklist is the expected first-load state.
        console.warn("[onboarding/status] fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ─── Task completion ────────────────────────────────────────────
  const markServerStep = useCallback(async (taskId: TaskId) => {
    const legacy = TASK_TO_LEGACY_STEP[taskId];
    if (!legacy) return;
    try {
      await api.post("/onboarding/complete-step", { step: legacy });
    } catch (err) {
      // Non-blocking — user can still proceed. Surface so user knows
      // their progress may not persist if the API is down.
      const msg = err instanceof Error ? err.message : "Couldn't save progress";
      showToast(msg, "warning", { title: "Progress not saved" });
    }
  }, [showToast]);

  // Persist firm form fields. Returns true on success or no-op (nothing to
  // send), false if the POST failed and the caller should keep the modal open.
  const saveFirmProfile = useCallback(
    async (data: FirmData): Promise<boolean> => {
      const websiteUrl = normalizeUrl(data.url);
      const linkedinUrl = normalizeUrl(data.linkedin);
      const aum = data.aum.trim() || undefined;
      const sectors = data.sectors.length > 0 ? data.sectors : undefined;

      // Only send keys with non-empty values — backend rejects all-undefined.
      const body: Record<string, unknown> = {};
      if (websiteUrl) body.websiteUrl = websiteUrl;
      if (linkedinUrl) body.linkedinUrl = linkedinUrl;
      if (aum) body.aum = aum;
      if (sectors) body.sectors = sectors;
      if (Object.keys(body).length === 0) return true;

      try {
        await api.post("/onboarding/firm-profile", body);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Couldn't save firm profile";
        showToast(msg, "error", { title: "Save failed" });
        return false;
      }
    },
    [showToast],
  );

  // Upload a real CIM to /api/ingest. On success, captures dealId so the
  // completion CTA routes to the new deal instead of /dashboard.
  const uploadCimFile = useCallback(
    async (file: File): Promise<boolean> => {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const response = await authFetchRaw("/ingest", { method: "POST", body: formData });
        if (!response.ok) {
          showToast("CIM upload failed — try again or skip this step", "error");
          return false;
        }
        const data: { deal?: { id?: string }; dealId?: string } = await response.json();
        const id = data.deal?.id ?? data.dealId;
        // Capture dealId so completion CTA can deep-link to /deals/:id.
        if (id) setCreatedDealId((prev) => prev ?? id);
        showToast("CIM uploaded — your deal is ready", "success");
        return true;
      } catch (err) {
        console.warn("[onboarding/cim-upload] failed:", err);
        showToast("CIM upload failed — try again or skip this step", "error");
        return false;
      }
    },
    [showToast],
  );

  const completeTask = useCallback(
    async (taskId: TaskId) => {
      // CIM step: prefer sample-deal demo path; otherwise upload a real file.
      if (taskId === "cim") {
        if (sampleDealId) {
          setBusyTask(taskId);
          try {
            const res = await api.post<{ dealId?: string }>("/onboarding/create-demo-deal", {
              sampleId: sampleDealId,
            });
            if (res?.dealId) setCreatedDealId((prev) => prev ?? res.dealId!);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Couldn't create demo deal";
            showToast(msg, "error", { title: "Demo deal failed" });
            setBusyTask(null);
            return;
          } finally {
            setBusyTask(null);
          }
        } else if (cimFile) {
          setBusyTask(taskId);
          const ok = await uploadCimFile(cimFile);
          setBusyTask(null);
          // Keep the modal open on failure so the user can retry.
          if (!ok) return;
        }
      }

      // Firm step: persist form fields before marking complete. If this
      // fails, keep the modal open so the user can retry.
      if (taskId === "firm") {
        setBusyTask(taskId);
        const ok = await saveFirmProfile(firmData);
        setBusyTask(null);
        if (!ok) return;
      }

      setCompleted((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        // Fire confetti when all tasks are done (legacy: fireConfetti in onboarding-flow.js)
        if (next.size >= TASKS.length && !confettiFiredRef.current) {
          confettiFiredRef.current = true;
          setShowConfetti(true);
        }
        return next;
      });
      setActiveTask(null);
      void markServerStep(taskId);
    },
    [cimFile, firmData, markServerStep, sampleDealId, saveFirmProfile, showToast, uploadCimFile],
  );

  const doneCount = completed.size;
  const allDone = doneCount >= TASKS.length;

  const openWorkspace = () => {
    if (createdDealId) router.push(`/deals/${createdDealId}`);
    else router.push("/dashboard");
  };

  // Same pe_onboarding_seen sessionStorage backup WelcomeModal uses — keeps
  // /dashboard from bouncing the user back here while the backend catches up.
  const markSeen = () => {
    try {
      sessionStorage.setItem("pe_onboarding_seen", "1");
    } catch (err) {
      // storage disabled (Safari private mode / cookie denial) — best-effort,
      // the API-side flag is the source of truth so silent degradation is fine.
      console.warn("[onboarding/markSeen] sessionStorage write failed:", err);
    }
  };

  const confirmSkip = async () => {
    // /onboarding/dismiss sets checklistDismissed=true (NOT /onboarding/skip;
    // that endpoint doesn't exist). Matches legacy markOnboardingSkipped in
    // onboarding-flow.js.
    markSeen();
    try {
      await Promise.all([
        api.post("/onboarding/welcome-shown", {}).catch(() => undefined),
        api.post("/onboarding/dismiss", {}).catch(() => undefined),
      ]);
    } finally {
      router.push("/dashboard");
    }
  };

  const startChecklist = async (useSample: boolean) => {
    if (useSample) {
      setSampleDealId("luktara");
      setCompleted((prev) => {
        const next = new Set(prev);
        next.add("cim");
        return next;
      });
    }
    setView("checklist");
    markSeen();
    try {
      await api.post("/onboarding/welcome-shown", {});
    } catch (err) {
      // Non-blocking — the user is already on the checklist. Backend will
      // re-flag this on the next status fetch if needed.
      console.warn("[onboarding/welcome-shown] post failed:", err);
    }
  };

  return (
    <>
      <Confetti active={showConfetti} />
      <TopNav doneCount={doneCount} onSkip={() => setShowSkip(true)} />

      {view === "welcome" ? (
        <WelcomeView onStart={() => startChecklist(false)} onSample={() => startChecklist(true)} />
      ) : (
        <ChecklistView
          completed={completed}
          onOpenTask={setActiveTask}
          allDone={allDone}
          onOpenWorkspace={openWorkspace}
          onDealId={(id) => setCreatedDealId((prev) => prev ?? id)}
        />
      )}

      {activeTask === "firm" && (
        <FirmTaskModal
          value={firmData}
          onChange={setFirmData}
          onClose={() => setActiveTask(null)}
          onComplete={() => completeTask("firm")}
          busy={busyTask === "firm"}
        />
      )}
      {activeTask === "cim" && (
        <CimTaskModal
          file={cimFile}
          onFile={setCimFile}
          sampleId={sampleDealId}
          onSample={setSampleDealId}
          onClose={() => setActiveTask(null)}
          onComplete={() => completeTask("cim")}
          busy={busyTask === "cim"}
        />
      )}
      {activeTask === "team" && (
        <TeamTaskModal
          invites={teamInvites}
          onChange={setTeamInvites}
          onClose={() => setActiveTask(null)}
          onComplete={() => completeTask("team")}
        />
      )}

      <SkipConfirmModal open={showSkip} onCancel={() => setShowSkip(false)} onConfirm={confirmSkip} />
    </>
  );
}

function TopNav({ doneCount, onSkip }: { doneCount: number; onSkip: () => void }) {
  return (
    <header className="bg-white border-b border-border-subtle">
      <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo className="size-[22px] shrink-0 text-primary" />
          <span className="font-bold text-[15px] tracking-tight text-primary">PE OS</span>
          <span className="text-[11px] text-text-muted font-mono uppercase tracking-wider ml-2 hidden sm:inline">
            Getting started
          </span>
        </div>
        <div className="flex items-center gap-4">
          {doneCount > 0 && doneCount < TASKS.length && (
            <span className="text-[12px] text-text-muted hidden md:inline">
              {doneCount}/{TASKS.length} done
            </span>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="text-[13px] text-text-secondary hover:text-primary transition-colors"
          >
            Skip setup
          </button>
        </div>
      </div>
    </header>
  );
}
