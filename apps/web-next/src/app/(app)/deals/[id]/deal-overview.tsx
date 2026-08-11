"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import { api } from "@/lib/api";
import type { DealDetail, Activity } from "./deal-detail-shared";
import { DealAccessTimeline } from "./deal-access-timeline";
import { HubSpotFieldsCard } from "@/components/HubSpotFieldsCard";

// ---------------------------------------------------------------------------
// Overview Tab — always-visible left-panel content (Key Risks,
// Add Note, Activity Feed).
// Ported from deal.html left-panel + deal-activity.js + deal-stages.js
// ---------------------------------------------------------------------------

export function OverviewTab({
  deal,
  activities,
  activitiesLoading,
  onRefreshActivities,
}: {
  deal: DealDetail;
  activities: Activity[];
  activitiesLoading: boolean;
  onRefreshActivities: () => void;
}) {
  const risks = deal.aiRisks?.keyRisks || [];
  const highlights = deal.aiRisks?.investmentHighlights || [];

  return (
    <div className="flex flex-col gap-3">
      <KeyRisksSection risks={risks} highlights={highlights} />

      <HubSpotFieldsCard properties={deal.hubspotProperties} />

      <DealAccessTimeline dealId={deal.id} />

      <AddNoteSection dealId={deal.id} onNoteAdded={onRefreshActivities} />

      <InlineActivityFeed
        activities={activities}
        loading={activitiesLoading}
        onRefresh={onRefreshActivities}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key Risks (ported from deal-stages.js renderKeyRisks)
// ---------------------------------------------------------------------------

function KeyRisksSection({ risks, highlights }: { risks: string[]; highlights: string[] }) {
  if (risks.length === 0 && highlights.length === 0) {
    return (
      <div className="rounded-xl p-5 flex flex-col" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)", maxHeight: "320px" }}>
        <div className="flex items-center gap-2 mb-4 shrink-0">
          <span className="material-symbols-outlined text-lg text-amber-500">warning</span>
          <h3 className="text-sm font-bold text-text-main uppercase tracking-wider">Key Risks</h3>
        </div>
        <div className="flex flex-col items-center justify-center py-6 text-text-muted">
          <span className="material-symbols-outlined text-2xl mb-2">shield</span>
          <p className="text-sm">No risks identified yet</p>
          <p className="text-xs mt-1">Upload documents or use AI chat to analyze risks</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-5 flex flex-col" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)", maxHeight: "320px" }}>
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <span className="material-symbols-outlined text-lg text-amber-500">warning</span>
        <h3 className="text-sm font-bold text-text-main uppercase tracking-wider">Key Risks</h3>
      </div>
      <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
        {risks.map((risk, i) => (
          <li
            key={i}
            className={cn(
              "bg-white border border-border-subtle p-3 rounded-lg hover:shadow-sm transition-all",
              i === 0 ? "border-l-2 border-l-red-400" : "border-l-2 border-l-orange-300"
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className={cn("material-symbols-outlined text-base mt-0.5 shrink-0", i === 0 ? "text-red-400" : "text-orange-400")}>
                {i === 0 ? "error" : "warning"}
              </span>
              <p className="text-xs text-text-secondary leading-snug">{risk}</p>
            </div>
          </li>
        ))}
        {highlights.map((h, i) => (
          <li key={`h-${i}`} className="bg-white border border-border-subtle border-l-2 border-l-emerald-500 p-3 rounded-lg hover:shadow-sm transition-all">
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined text-emerald-500 text-base mt-0.5 shrink-0">check_circle</span>
              <p className="text-xs text-text-secondary leading-snug">{h}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Note (ported from deal-activity.js addNote + initActivityFeed +
// initMentionAutocomplete). Supports @ mentions sourced from /api/users.
// ---------------------------------------------------------------------------

interface MentionUser {
  id: string;
  name: string;
  email: string;
  initials: string;
}

// Session-scoped cache of org users for @-mentions. The legacy app fetches
// once and caches in a module-level variable (deal-activity.js:117) — same
// pattern here. Cleared on hard reload.
let _mentionUsersCache: MentionUser[] | null = null;
let _mentionUsersInflight: Promise<MentionUser[]> | null = null;

async function fetchMentionUsers(): Promise<MentionUser[]> {
  if (_mentionUsersCache) return _mentionUsersCache;
  if (_mentionUsersInflight) return _mentionUsersInflight;
  _mentionUsersInflight = (async () => {
    try {
      const data = await api.get<unknown>("/users");
      // The API returns either an array directly or { users: [...] }. Handle both.
      const list = Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : (((data as { users?: Array<Record<string, unknown>> })?.users) ?? []);
      const mapped: MentionUser[] = list.map((u) => {
        const name = (u.name as string) || ((u.email as string)?.split("@")[0]) || "Unknown";
        const email = (u.email as string) || "";
        const initials = name
          .split(" ")
          .map((w) => w[0])
          .filter(Boolean)
          .join("")
          .toUpperCase()
          .slice(0, 2) || "??";
        return { id: u.id as string, name, email, initials };
      });
      _mentionUsersCache = mapped;
      return mapped;
    } catch (err) {
      // Failed fetch — return empty list. Don't poison the cache so the
      // next attempt can retry.
      console.warn("[deal-overview] fetchMentionUsers failed:", err);
      return [];
    } finally {
      _mentionUsersInflight = null;
    }
  })();
  return _mentionUsersInflight;
}

function AddNoteSection({ dealId, onNoteAdded }: { dealId: string; onNoteAdded: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Mention dropdown state. _mentionStart is the index of the `@` in the note
  // string; null when the picker is closed.
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionFiltered, setMentionFiltered] = useState<MentionUser[]>([]);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  // Tracks emails the picker actually inserted into the note. Sent to the
  // server alongside the description so notification fan-out doesn't have to
  // fuzzy-match @<Name> back to a User row — which is ambiguous when two
  // users share a display name. Email is unique per User and is the field
  // the dropdown already shows next to each name. Cleared after submit.
  const [mentionedEmails, setMentionedEmails] = useState<Set<string>>(new Set());

  const mentionOpen = mentionStart !== null && mentionFiltered.length > 0;

  // Pre-warm the user cache once so the first @ keystroke doesn't lag.
  useEffect(() => {
    fetchMentionUsers().then(setUsers);
  }, []);

  const closeMention = useCallback(() => {
    setMentionStart(null);
    setMentionFiltered([]);
    setMentionSelectedIdx(0);
  }, []);

  // Click-outside dismissal — matches the legacy `blur` + setTimeout behavior
  // (deal-activity.js:212) but more deterministic.
  useEffect(() => {
    if (!mentionOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMention();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mentionOpen, closeMention]);

  const recomputeMention = useCallback((value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    // Match legacy rule (deal-activity.js:150): the `@` must be at the start
    // of the input or preceded by a space.
    if (atIdx === -1 || (atIdx > 0 && before[atIdx - 1] !== " ")) {
      closeMention();
      return;
    }
    const query = before.slice(atIdx + 1).toLowerCase();
    // Substring match against name OR email — same as legacy filter.
    const filtered = (users.length ? users : _mentionUsersCache || [])
      .filter((u) => u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query))
      .slice(0, 6);
    if (filtered.length === 0) {
      closeMention();
      return;
    }
    setMentionStart(atIdx);
    setMentionFiltered(filtered);
    setMentionSelectedIdx(0);
  }, [users, closeMention]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setNote(value);
    const cursor = e.target.selectionStart ?? value.length;
    // If the cache hasn't loaded yet, kick it off; recompute uses whatever's
    // available right now (state OR raw cache) so we don't drop the first @.
    if (!users.length && !_mentionUsersCache) {
      void fetchMentionUsers().then(setUsers);
    }
    recomputeMention(value, cursor);
  }, [recomputeMention, users.length]);

  const insertMention = useCallback((user: MentionUser) => {
    const input = inputRef.current;
    if (input === null || mentionStart === null) return;
    const cursor = input.selectionStart ?? note.length;
    const before = note.slice(0, mentionStart);
    const after = note.slice(cursor);
    const next = `${before}@${user.name} ${after}`;
    setNote(next);
    setMentionedEmails((prev) => {
      const nextSet = new Set(prev);
      if (user.email) nextSet.add(user.email);
      return nextSet;
    });
    closeMention();
    // Restore focus + cursor after the React update lands.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const newCursor = before.length + user.name.length + 2;
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    });
  }, [note, mentionStart, closeMention]);

  const submitNote = useCallback(async () => {
    const text = note.trim();
    if (!text) return;
    setSaving(true);
    try {
      // Only send emails whose @<Name> token still appears in the final
      // text — covers the case where a user picked a name then deleted it
      // before submit. Cheap substring check; the server treats this list
      // as the source of truth, so a stray include would notify the wrong
      // person.
      const nameByEmail = new Map(users.map((u) => [u.email, u.name] as const));
      const stillPresent = Array.from(mentionedEmails).filter((email) => {
        const name = nameByEmail.get(email);
        return name ? text.includes(`@${name}`) : false;
      });
      await api.post(`/deals/${dealId}/activities`, {
        type: "NOTE_ADDED",
        title: "Note added",
        description: text,
        ...(stillPresent.length > 0 && { mentionedEmails: stillPresent }),
      });
      setNote("");
      setMentionedEmails(new Set());
      onNoteAdded();
    } catch (err) {
      console.warn("[deal-overview] submitNote failed:", err);
    } finally {
      setSaving(false);
    }
  }, [dealId, note, onNoteAdded, mentionedEmails, users]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSelectedIdx((i) => Math.min(i + 1, mentionFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const sel = mentionFiltered[mentionSelectedIdx];
        if (sel) insertMention(sel);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    } else if (e.key === "Enter") {
      // Plain Enter with no picker open submits the note (legacy behavior).
      submitNote();
    }
  }, [mentionOpen, mentionFiltered, mentionSelectedIdx, insertMention, closeMention, submitNote]);

  return (
    // `backdrop-filter` on this wrapper creates a stacking context — the
    // mention dropdown's z-30 is therefore scoped *inside* this card. The
    // sibling InlineActivityFeed has no z-index, so without an explicit
    // value here it would render on top in document order and clip the
    // dropdown. relative + z-20 lifts the whole AddNote card above the
    // feed so the dropdown is visible.
    <div ref={containerRef} className="rounded-xl p-4 relative z-20" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)" }}>
      <h3 className="text-sm font-bold text-text-main uppercase tracking-wider mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-amber-500 text-lg">sticky_note_2</span>
        Add Note
      </h3>
      <div className="flex gap-2 relative">
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={note}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder="Add a note about this deal... use @ to mention"
            className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
          {mentionOpen && (
            <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-border-subtle rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto custom-scrollbar">
              {mentionFiltered.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  // Use mousedown so we beat the input's onBlur — matches the
                  // legacy `mousedown` + preventDefault handler.
                  onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
                  onMouseEnter={() => setMentionSelectedIdx(i)}
                  className={cn(
                    "w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors",
                    i === mentionSelectedIdx ? "bg-primary/5" : "hover:bg-primary/5"
                  )}
                >
                  <span className="size-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0" style={{ background: "#003366" }}>
                    {u.initials}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-800 truncate">{u.name}</p>
                    {u.email && <p className="text-[10px] text-gray-400 truncate">{u.email}</p>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={submitNote}
          disabled={!note.trim() || saving}
          className="px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1 disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-lg">add</span>
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Activity Feed (ported from deal-activity.js renderActivityFeed)
// ---------------------------------------------------------------------------

const ACTIVITY_ICONS: Record<string, { icon: string; color: string; bg: string }> = {
  DOCUMENT_UPLOADED: { icon: "upload_file", color: "text-blue-600", bg: "bg-blue-100" },
  STAGE_CHANGED: { icon: "swap_horiz", color: "text-purple-600", bg: "bg-purple-100" },
  NOTE_ADDED: { icon: "sticky_note_2", color: "text-amber-600", bg: "bg-amber-100" },
  MEETING_SCHEDULED: { icon: "event", color: "text-green-600", bg: "bg-green-100" },
  CALL_LOGGED: { icon: "call", color: "text-cyan-600", bg: "bg-cyan-100" },
  EMAIL_SENT: { icon: "mail", color: "text-red-600", bg: "bg-red-100" },
  STATUS_UPDATED: { icon: "update", color: "text-indigo-600", bg: "bg-indigo-100" },
  TEAM_MEMBER_ADDED: { icon: "person_add", color: "text-emerald-600", bg: "bg-emerald-100" },
};

function InlineActivityFeed({ activities, loading, onRefresh }: { activities: Activity[]; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)" }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-text-main uppercase tracking-wider flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-lg">history</span>
          Activity Feed
        </h3>
        <button onClick={onRefresh} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1 transition-colors">
          <span className="material-symbols-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>
      <div className="space-y-3 max-h-64 overflow-y-auto custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-8 text-text-muted">
            <span className="material-symbols-outlined animate-spin text-primary mr-2">sync</span>
            Loading activities...
          </div>
        )}
        {!loading && activities.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-2xl mb-2">inbox</span>
            <p className="text-sm">No activities yet</p>
          </div>
        )}
        {!loading && activities.slice(0, 10).map((activity) => {
          const iconDef = ACTIVITY_ICONS[activity.type || ""] || { icon: "info", color: "text-gray-600", bg: "bg-gray-100" };
          const userName = activity.user?.name || activity.userName;
          return (
            <div key={activity.id} className="flex items-start gap-3 p-3 bg-white rounded-lg border border-border-subtle hover:border-primary/30 transition-colors">
              <div className={cn("size-8 rounded-full flex items-center justify-center shrink-0", iconDef.bg)}>
                <span className={cn("material-symbols-outlined text-sm", iconDef.color)}>{iconDef.icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-main leading-tight">{activity.title || activity.action}</p>
                {activity.description && <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{activity.description}</p>}
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-text-muted font-medium">{formatRelativeTime(activity.createdAt)}</span>
                  {userName && (
                    <>
                      <span className="text-[10px] text-text-muted">&middot;</span>
                      <span className="text-[10px] text-text-muted">{userName}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

