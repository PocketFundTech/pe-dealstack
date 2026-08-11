"use client";

import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import {
  Contact, TYPE_CONFIG, SCORE_CONFIG,
  getInitials, getRelationshipLabel,
} from "./components";
import {
  STRENGTH_TIER_STYLE, strengthTierForContact, strengthTooltip,
} from "@/lib/contacts/strength";

// Small green/amber/gray relationship-strength pill — the core list-triage
// affordance. Tier semantics live in lib/contacts/strength.ts so the list and
// the detail panel agree. Renders even for unscored contacts (cold) so every
// row carries a consistent signal.
function StrengthPill({
  contact, contactScores, className,
}: {
  contact: Contact;
  contactScores: Record<string, { score: number; label: string }>;
  className?: string;
}) {
  const score = contactScores[contact.id];
  const tier = strengthTierForContact(score);
  const style = STRENGTH_TIER_STYLE[tier];
  return (
    <span
      title={strengthTooltip(score)}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide shrink-0",
        style.bg, style.text, className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", style.dot)} />
      {style.label}
    </span>
  );
}

// ─── Contact card (grid view) and row (list view) renderers ─────────────────
// Extracted from page.tsx so the page module stays under the 500-line budget.

// True when the contact's follow-up date is in the past (date-only compare).
function isFollowUpOverdue(followUpAt?: string | null): boolean {
  if (!followUpAt) return false;
  const due = new Date(followUpAt);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

export function ContactCard({
  contact,
  contactScores,
  onClick,
}: {
  contact: Contact;
  contactScores: Record<string, { score: number; label: string }>;
  onClick: () => void;
}) {
  const ts = TYPE_CONFIG[contact.type] || TYPE_CONFIG.OTHER;
  const sd = contactScores[contact.id];
  const scoreLabel = sd ? sd.label : getRelationshipLabel(undefined);
  const sc = SCORE_CONFIG[scoreLabel] || SCORE_CONFIG.Cold;
  // Filter out enriched: tags (matches legacy)
  const visibleTags = (contact.tags || []).filter((t) => !t.startsWith("enriched:"));
  const tags = visibleTags.slice(0, 4);
  const overflow = visibleTags.length - 4;
  const lastContacted = contact.lastInteractionAt ? `Contacted ${formatRelativeTime(contact.lastInteractionAt)}` : "Never contacted";
  const linkedDealsCount = contact.linkedDeals ? contact.linkedDeals.length : 0;
  const followUpOverdue = isFollowUpOverdue(contact.followUpAt);

  return (
    <div onClick={onClick} className="cursor-pointer">
      <article className="bg-surface-card rounded-lg border border-border-subtle p-5 hover:border-primary/30 transition-all flex flex-col h-full shadow-card hover:shadow-card-hover relative group">
        <div className="flex items-start gap-3.5 mb-4">
          <div className="size-11 rounded-full flex items-center justify-center shrink-0 text-sm font-bold shadow-sm" style={{ backgroundColor: ts.avatarBg, color: ts.avatarText }}>
            {getInitials(contact.firstName, contact.lastName)}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-text-main font-bold text-[15px] leading-tight group-hover:text-primary transition-colors truncate">{contact.firstName} {contact.lastName}</h3>
            {contact.title && <p className="text-text-secondary text-xs mt-0.5 truncate">{contact.title}</p>}
          </div>
          <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider shrink-0", ts.bg, ts.text)}>{ts.label}</span>
        </div>
        {contact.company && (
          <div className="flex items-center gap-1.5 mb-3">
            <span className="material-symbols-outlined text-text-muted text-[16px]">business</span>
            <span className="text-sm text-text-secondary truncate">{contact.company}</span>
          </div>
        )}
        <div className="flex flex-col gap-1.5 mb-3">
          {contact.email && (
            <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors truncate">
              <span className="material-symbols-outlined text-[14px]">mail</span><span className="truncate">{contact.email}</span>
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors">
              <span className="material-symbols-outlined text-[14px]">call</span>{contact.phone}
            </a>
          )}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.map((t, i) => <span key={i} className="px-2 py-0.5 rounded-full bg-gray-50 text-text-muted text-[10px] font-medium border border-border-subtle">{t}</span>)}
            {overflow > 0 && <span className="text-[10px] text-text-muted">+{overflow}</span>}
          </div>
        )}
        <div className="flex items-center justify-between mt-auto pt-3 border-t border-border-subtle">
          <span className="text-[11px] text-primary font-medium">{lastContacted}</span>
          <div className="flex items-center gap-2">
            {followUpOverdue && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-red-100 text-red-700" title="Follow-up overdue">
                <span className="material-symbols-outlined text-[12px]">event_busy</span>Due
              </span>
            )}
            {sd && <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold", sc.bg, sc.text)}><span className={cn("w-1.5 h-1.5 rounded-full shrink-0", sc.dot)} />{sd.score}</span>}
            {linkedDealsCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-text-muted font-medium">
                <span className="material-symbols-outlined text-[14px]">work</span>{linkedDealsCount}
              </span>
            )}
          </div>
        </div>
      </article>
    </div>
  );
}

export function ContactRow({
  contact,
  contactScores,
  onClick,
}: {
  contact: Contact;
  contactScores: Record<string, { score: number; label: string }>;
  onClick: () => void;
}) {
  const ts = TYPE_CONFIG[contact.type] || TYPE_CONFIG.OTHER;
  const sd = contactScores[contact.id];
  const scoreLabel = sd ? sd.label : "Cold";
  const sc = SCORE_CONFIG[scoreLabel] || SCORE_CONFIG.Cold;
  const lastContacted = contact.lastInteractionAt ? formatRelativeTime(contact.lastInteractionAt) : "--";

  return (
    <tr onClick={onClick} className="hover:bg-slate-50/80 cursor-pointer transition-colors border-b border-border-subtle">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold" style={{ backgroundColor: ts.avatarBg, color: ts.avatarText }}>{getInitials(contact.firstName, contact.lastName)}</div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-main truncate flex items-center gap-1.5">
              {contact.firstName} {contact.lastName}
              <StrengthPill contact={contact} contactScores={contactScores} />
              {isFollowUpOverdue(contact.followUpAt) && (
                <span className="material-symbols-outlined text-[14px] text-red-500 shrink-0" title="Follow-up overdue">event_busy</span>
              )}
            </p>
            {contact.title && <p className="text-xs text-text-muted truncate">{contact.title}</p>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-text-secondary truncate max-w-[180px]">{contact.company || "--"}</td>
      <td className="px-4 py-3"><span className={cn("px-2 py-0.5 rounded-md text-[10px] font-bold uppercase", ts.bg, ts.text)}>{ts.label}</span></td>
      <td className="px-4 py-3 text-sm text-text-muted truncate max-w-[200px]">{contact.email || "--"}</td>
      <td className="px-4 py-3 text-sm text-primary">{lastContacted}</td>
      <td className="px-4 py-3">{sd ? <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold", sc.bg, sc.text)}><span className={cn("w-1.5 h-1.5 rounded-full shrink-0", sc.dot)} />{sd.score}</span> : <span className="text-text-muted text-xs">--</span>}</td>
    </tr>
  );
}

export const TABLE_HEADERS = ["Name", "Company", "Type", "Email", "Last Contact", "Score"];

export const TABLE_TH_CLS = "px-4 py-3 text-left text-[11px] font-bold text-text-muted uppercase tracking-wider";
