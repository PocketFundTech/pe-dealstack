"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { TeaserProfile } from "@/lib/teaser";

// Tabs to switch between the firm's named criteria profiles, plus add/rename/
// delete affordances. Rename is inline; delete is confirmed by the parent via
// ConfirmDialog (never window.confirm).
export function ProfilePicker({
  profiles,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onRequestDelete,
}: {
  profiles: TeaserProfile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const startRename = (profile: TeaserProfile) => {
    setRenamingId(profile.id);
    setDraftName(profile.name);
  };

  const commitRename = () => {
    if (renamingId) {
      const trimmed = draftName.trim();
      onRename(renamingId, trimmed || "Untitled profile");
    }
    setRenamingId(null);
    setDraftName("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {profiles.map((profile) => {
        const isActive = profile.id === activeId;
        const isRenaming = profile.id === renamingId;
        if (isRenaming) {
          return (
            <input
              key={profile.id}
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  setRenamingId(null);
                  setDraftName("");
                }
              }}
              className="rounded-lg border border-primary px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
          );
        }
        return (
          <div
            key={profile.id}
            className={cn(
              "group flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "border-primary bg-primary-light text-primary"
                : "border-border-subtle bg-white text-text-secondary hover:border-border-focus",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(profile.id)}
              onDoubleClick={() => startRename(profile)}
              className="outline-none"
            >
              {profile.name || "Untitled profile"}
            </button>
            {isActive && (
              <>
                <button
                  type="button"
                  onClick={() => startRename(profile)}
                  className="text-text-muted hover:text-primary transition-colors"
                  aria-label="Rename profile"
                  title="Rename"
                >
                  <span className="material-symbols-outlined text-[15px] block">edit</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRequestDelete(profile.id)}
                  className="text-text-muted hover:text-red-500 transition-colors"
                  aria-label="Delete profile"
                  title="Delete"
                >
                  <span className="material-symbols-outlined text-[15px] block">delete</span>
                </button>
              </>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1 rounded-lg border border-dashed border-border-subtle px-3 py-1.5 text-sm font-medium text-text-secondary hover:border-border-focus hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        Add profile
      </button>
    </div>
  );
}
