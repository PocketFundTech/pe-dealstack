"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type {
  Action,
  ChatContext,
  ChatMessage,
  DraftEmailPayload,
} from "./ai-assistant-shared";
import {
  getContextIcon,
  getContextLabel,
  getPlaceholder,
  getSuggestedPrompts,
  isDraftEmailAction,
  isMutationAction,
  isNavigateAction,
} from "./ai-assistant-shared";

// ── Inline style objects ─────────────────────────────────────────────────────
// Animations are defined in globals.css (ai-fab-pulse, ai-fade-in, etc.).

const S = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 9971,
    background: "rgba(0,0,0,0.2)", backdropFilter: "blur(2px)",
    animation: "aiFadeIn 0.15s ease-out",
  } satisfies CSSProperties,

  drawer: {
    position: "fixed", bottom: 24, right: 24, zIndex: 9972,
    width: 480, maxWidth: "calc(100vw - 48px)",
    height: 620, maxHeight: "calc(100vh - 48px)",
    background: "#fff", borderRadius: 16,
    boxShadow: "0 25px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    animation: "aiDrawerIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
  } satisfies CSSProperties,

  header: {
    padding: "16px 16px 12px", borderBottom: "1px solid #E5E7EB",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "linear-gradient(135deg, #003366 0%, #004488 100%)",
    color: "#fff", borderRadius: "16px 16px 0 0",
  } satisfies CSSProperties,

  closeBtn: {
    background: "rgba(255,255,255,0.15)", border: "none", color: "#fff",
    width: 28, height: 28, borderRadius: 8,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    transition: "background 0.15s",
  } satisfies CSSProperties,

  messagesArea: {
    flex: 1, overflowY: "auto", padding: 16,
    display: "flex", flexDirection: "column", gap: 12,
  } satisfies CSSProperties,

  msgBase: {
    maxWidth: "85%", padding: "10px 14px", borderRadius: 12,
    fontSize: 13, lineHeight: 1.5,
    animation: "aiMsgIn 0.2s ease-out",
  } satisfies CSSProperties,

  msgAssistant: {
    alignSelf: "flex-start", background: "#F3F4F6", color: "#111827",
    borderBottomLeftRadius: 4,
  } satisfies CSSProperties,

  msgUser: {
    alignSelf: "flex-end", background: "#003366", color: "#fff",
    borderBottomRightRadius: 4,
  } satisfies CSSProperties,

  typingWrap: {
    alignSelf: "flex-start", background: "#F3F4F6",
    padding: "10px 18px", borderRadius: 12, borderBottomLeftRadius: 4,
    display: "flex", gap: 4,
  } satisfies CSSProperties,

  toolWrap: {
    alignSelf: "flex-start", background: "#EEF2F7", color: "#003366",
    padding: "8px 14px", borderRadius: 12, borderBottomLeftRadius: 4,
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 12, fontWeight: 500,
    animation: "aiMsgIn 0.2s ease-out",
  } satisfies CSSProperties,

  toolSpinner: {
    width: 14, height: 14, borderRadius: "50%",
    border: "2px solid rgba(0,51,102,0.25)", borderTopColor: "#003366",
  } satisfies CSSProperties,

  actionsWrap: {
    display: "flex", flexDirection: "column", gap: 8,
    alignSelf: "flex-start", maxWidth: "85%", marginTop: -4,
  } satisfies CSSProperties,

  actionChip: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "7px 12px", fontSize: 12, fontWeight: 600,
    color: "#fff", background: "#003366", border: "none",
    borderRadius: 10, cursor: "pointer", transition: "opacity 0.15s",
    fontFamily: "'Inter', sans-serif", textAlign: "left",
  } satisfies CSSProperties,

  draftBlock: {
    border: "1px solid #E5E7EB", borderRadius: 10, background: "#fff",
    overflow: "hidden", maxWidth: "85%", alignSelf: "flex-start",
    fontSize: 12,
  } satisfies CSSProperties,

  draftHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 12px", background: "#F8F9FA", borderBottom: "1px solid #E5E7EB",
    fontWeight: 600, color: "#374151",
  } satisfies CSSProperties,

  draftCopyBtn: {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "4px 10px", fontSize: 11, fontWeight: 600,
    color: "#003366", background: "#F0F4F8",
    border: "1px solid rgba(0,51,102,0.2)", borderRadius: 8,
    cursor: "pointer", fontFamily: "'Inter', sans-serif",
  } satisfies CSSProperties,

  draftField: {
    padding: "6px 12px", borderBottom: "1px solid #F1F1F1",
    color: "#6B7280",
  } satisfies CSSProperties,

  draftBody: {
    padding: "10px 12px", whiteSpace: "pre-wrap",
    color: "#111827", lineHeight: 1.5, fontFamily: "'Inter', sans-serif",
  } satisfies CSSProperties,

  typingDot: {
    width: 6, height: 6, background: "#9CA3AF", borderRadius: "50%",
    animation: "aiTypingDot 1.4s ease-in-out infinite",
  } satisfies CSSProperties,

  promptsWrap: {
    padding: "8px 12px 4px", display: "flex", flexWrap: "wrap", gap: 6,
    borderTop: "1px solid #E5E7EB", background: "#FFF",
  } satisfies CSSProperties,

  promptChip: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "6px 12px", fontSize: 12, fontWeight: 500,
    color: "#003366", background: "#F0F4F8",
    border: "1px solid rgba(0,51,102,0.15)", borderRadius: 999,
    cursor: "pointer", transition: "all 0.15s",
    fontFamily: "'Inter', sans-serif",
  } satisfies CSSProperties,

  inputBar: {
    padding: "12px 16px", borderTop: "1px solid #E5E7EB",
    display: "flex", gap: 8, alignItems: "flex-end", background: "#FAFAFA",
  } satisfies CSSProperties,

  textarea: {
    flex: 1, border: "1px solid #E5E7EB", borderRadius: 10,
    padding: "10px 14px", fontSize: 13, color: "#111827",
    background: "#fff", outline: "none", fontFamily: "'Inter', sans-serif",
    transition: "border-color 0.15s",
    resize: "none", minHeight: 40, maxHeight: 120, lineHeight: 1.4,
  } satisfies CSSProperties,

  sendBtn: {
    width: 36, height: 36, borderRadius: 10,
    background: "#003366", color: "#fff", border: "none",
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all 0.15s", flexShrink: 0,
  } satisfies CSSProperties,
} as const;

// ── Component ───────────────────────────────────────────────────────────────

interface DrawerProps {
  context: ChatContext;
  messages: ChatMessage[];
  isLoading: boolean;
  /** True once the first streamed token has landed for the current turn. */
  isStreaming: boolean;
  /** Transient tool-activity label (e.g. "Searching documents…"), or null. */
  toolActivity: string | null;
  inputValue: string;
  setInputValue: (v: string) => void;
  onClose: () => void;
  onSend: () => void;
  onSendPrompt: (prompt: string) => void;
  /** Click handler for inert actions (navigate). */
  onActionClick: (action: Action) => void;
  /** Called after the user confirms a needsConfirm mutation. */
  onConfirmMutation: (action: Action) => void;
  /** Copy a draft-email body to the clipboard. */
  onCopyDraft: (text: string) => void;
}

export function AIAssistantDrawer({
  context,
  messages,
  isLoading,
  isStreaming,
  toolActivity,
  inputValue,
  setInputValue,
  onClose,
  onSend,
  onSendPrompt,
  onActionClick,
  onConfirmMutation,
  onCopyDraft,
}: DrawerProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Mutation awaiting confirmation (renders the shared ConfirmDialog).
  const [pendingMutation, setPendingMutation] = useState<Action | null>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Focus on mount
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [inputValue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // Empty state: only the welcome message exists, show suggested prompts
  const showPrompts = messages.length <= 1;
  const prompts = showPrompts ? getSuggestedPrompts(context) : [];

  const sendDisabled = isLoading || !inputValue.trim();

  return (
    <>
      <div style={S.overlay} onClick={onClose} />

      <div style={S.drawer} role="dialog" aria-label="AI Assistant">
        {/* Header */}
        <div style={S.header}>
          <div>
            <div className="flex items-center gap-2 text-[15px] font-bold text-white">
              <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
              AI Assistant
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-[11px] font-medium text-white/80">
              <span className="material-symbols-outlined text-[14px]">
                {getContextIcon(context)}
              </span>
              {getContextLabel(context)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ai-close-btn"
            style={S.closeBtn}
            aria-label="Close AI Assistant"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {/* Messages */}
        <div className="ai-messages-area" style={S.messagesArea}>
          {messages.map((msg, i) => {
            // An empty assistant bubble is the streaming placeholder before any
            // token arrives — the typing/tool indicator stands in for it.
            const isEmptyPlaceholder = msg.role === "assistant" && msg.content === "";
            if (isEmptyPlaceholder) return null;
            return (
              <div key={i} style={{ display: "contents" }}>
                <div
                  className={msg.role === "assistant" ? "ai-msg-assistant" : undefined}
                  style={{
                    ...S.msgBase,
                    ...(msg.role === "user" ? S.msgUser : S.msgAssistant),
                  }}
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(
                      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
                    ),
                  }}
                />
                {msg.role === "assistant" && msg.actions && msg.actions.length > 0 && (
                  <ActionList
                    actions={msg.actions}
                    onActionClick={onActionClick}
                    onRequestConfirm={setPendingMutation}
                    onCopyDraft={onCopyDraft}
                  />
                )}
              </div>
            );
          })}

          {/* Tool activity takes priority over the generic typing dots. */}
          {isLoading && toolActivity && (
            <div style={S.toolWrap}>
              <span className="animate-spin" style={S.toolSpinner} />
              <span>{toolActivity}</span>
            </div>
          )}

          {isLoading && !toolActivity && !isStreaming && (
            <div style={S.typingWrap}>
              <span style={S.typingDot} />
              <span style={{ ...S.typingDot, animationDelay: "0.2s" }} />
              <span style={{ ...S.typingDot, animationDelay: "0.4s" }} />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggested prompt chips (only on empty state) */}
        {showPrompts && prompts.length > 0 && (
          <div style={S.promptsWrap}>
            {prompts.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onSendPrompt(p.prompt)}
                disabled={isLoading}
                style={S.promptChip}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = "#E4ECF4";
                  e.currentTarget.style.borderColor = "rgba(0,51,102,0.3)";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = "#F0F4F8";
                  e.currentTarget.style.borderColor = "rgba(0,51,102,0.15)";
                }}
              >
                <span className="material-symbols-outlined text-[14px]" style={{ color: "#003366" }}>
                  {p.icon}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>{p.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Input bar */}
        <div style={S.inputBar}>
          <textarea
            ref={textareaRef}
            className="ai-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder(context)}
            autoComplete="off"
            rows={1}
            style={S.textarea}
          />
          <button
            type="button"
            className="ai-send-btn"
            onClick={onSend}
            disabled={sendDisabled}
            aria-label="Send message"
            style={{
              ...S.sendBtn,
              ...(sendDisabled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
            }}
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
          </button>
        </div>
      </div>

      {/* Confirm chip → shared ConfirmDialog for needsConfirm mutations. */}
      <ConfirmDialog
        open={pendingMutation !== null}
        title="Confirm action"
        message={
          pendingMutation
            ? `${pendingMutation.label}? This will make a change.`
            : ""
        }
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (pendingMutation) onConfirmMutation(pendingMutation);
          setPendingMutation(null);
        }}
        onCancel={() => setPendingMutation(null)}
      />
    </>
  );
}

// ── Action rendering ─────────────────────────────────────────────────────────
// Per the Action contract:
//   navigate    → button that pushes the router (inert, no confirm)
//   draftEmail  → copyable draft block (inert, no confirm)
//   mutations   → chip that opens the confirm dialog, then calls the endpoint

function ActionList({
  actions,
  onActionClick,
  onRequestConfirm,
  onCopyDraft,
}: {
  actions: Action[];
  onActionClick: (action: Action) => void;
  onRequestConfirm: (action: Action) => void;
  onCopyDraft: (text: string) => void;
}) {
  return (
    <div style={S.actionsWrap}>
      {actions.map((action, i) => {
        if (isDraftEmailAction(action)) {
          return <DraftEmail key={i} action={action} onCopyDraft={onCopyDraft} />;
        }
        if (isNavigateAction(action)) {
          return (
            <button
              key={i}
              type="button"
              style={S.actionChip}
              onClick={() => onActionClick(action)}
              onMouseOver={(e) => (e.currentTarget.style.opacity = "0.9")}
              onMouseOut={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <span className="material-symbols-outlined text-[15px]">open_in_new</span>
              {action.label}
            </button>
          );
        }
        if (isMutationAction(action)) {
          return (
            <button
              key={i}
              type="button"
              style={S.actionChip}
              onClick={() => onRequestConfirm(action)}
              onMouseOver={(e) => (e.currentTarget.style.opacity = "0.9")}
              onMouseOut={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <span className="material-symbols-outlined text-[15px]">bolt</span>
              {action.label}
            </button>
          );
        }
        // Unknown action shape — render an inert labelled chip rather than
        // crash or silently drop it.
        return (
          <div
            key={i}
            style={{ ...S.actionChip, background: "#9CA3AF", cursor: "default" }}
          >
            {action.label}
          </div>
        );
      })}
    </div>
  );
}

function DraftEmail({
  action,
  onCopyDraft,
}: {
  action: Action;
  onCopyDraft: (text: string) => void;
}) {
  const p = action.payload as DraftEmailPayload;
  return (
    <div style={S.draftBlock}>
      <div style={S.draftHeader}>
        <span>{action.label || "Email draft"}</span>
        <button
          type="button"
          style={S.draftCopyBtn}
          onClick={() => onCopyDraft(draftToText(p))}
        >
          <span className="material-symbols-outlined text-[13px]">content_copy</span>
          Copy
        </button>
      </div>
      {p.to && <div style={S.draftField}>To: {p.to}</div>}
      {p.subject && <div style={S.draftField}>Subject: {p.subject}</div>}
      <div style={S.draftBody}>{p.body}</div>
    </div>
  );
}

function draftToText(p: DraftEmailPayload): string {
  const lines: string[] = [];
  if (p.to) lines.push(`To: ${p.to}`);
  if (p.subject) lines.push(`Subject: ${p.subject}`);
  if (lines.length > 0) lines.push("");
  lines.push(p.body);
  return lines.join("\n");
}
