"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { cn } from "@/lib/cn";
import type { ChatMessage, DealDetail } from "./deal-detail-shared";
import { ClearChatModal, AISettingsModal } from "./deal-panels";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { SuggestionChips } from "./deal-tabs-suggestions";
import { ContextDocIndicators } from "./deal-tabs-context-indicators";
import { AIMessageActions } from "./deal-tabs-ai-message-actions";
import { ArtifactActionButton } from "./deal-tabs-artifact-button";
import { SlashMenu } from "./deal-tabs-slash-menu";
import { AiMessageBody } from "./deal-tabs-ai-message-body";
import { filterSkills, findSkillCommand, expandChatInput, type Skill } from "@/lib/dealchat-skills";

// ---------------------------------------------------------------------------
// Chat Tab
// ---------------------------------------------------------------------------

export function ChatTab({
  deal,
  messages,
  chatInput,
  setChatInput,
  chatSending,
  onSend,
  onSendPrompt,
  onClearChat,
  chatEndRef,
}: {
  deal: DealDetail | null;
  messages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  chatSending: boolean;
  onSend: () => void;
  onSendPrompt: (text: string) => void;
  onClearChat?: () => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [showClearModal, setShowClearModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // When the user picks a skill from the slash menu we want the caret to
  // land at the end of the freshly-inserted `/<command> ` so they can keep
  // typing additional context immediately. Setting `pendingCaretToEnd`
  // queues a focus + selection adjustment for the next render tick.
  const [pendingCaretToEnd, setPendingCaretToEnd] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; status: "uploading" | "done" | "error" }>>([]);

  // ---- Slash-command menu state -----------------------------------------
  // The menu is "open" whenever chatInput starts with `/`. We track the
  // highlighted index for keyboard nav and reset it whenever the filtered
  // list changes (so ArrowDown from a fresh `/` lands on row 0).
  const slashOpen = chatInput.startsWith("/");
  const slashQuery = slashOpen ? chatInput.slice(1) : "";
  const filteredSkills = useMemo(
    () => (slashOpen ? filterSkills(slashQuery) : []),
    [slashOpen, slashQuery],
  );
  const [slashIdx, setSlashIdx] = useState(0);
  // `dismissed` lets Escape close the menu even though chatInput still
  // starts with `/`. Cleared when the user edits the input again.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMenuVisible = slashOpen && !slashDismissed && filteredSkills.length >= 0;

  useEffect(() => {
    // Clamp the highlighted row whenever the filtered list shrinks past it.
    if (slashIdx >= filteredSkills.length) setSlashIdx(0);
  }, [filteredSkills.length, slashIdx]);

  useEffect(() => {
    // Re-arm the menu whenever the input no longer starts with `/`.
    if (!slashOpen && slashDismissed) setSlashDismissed(false);
  }, [slashOpen, slashDismissed]);

  const pickSkill = useCallback(
    (skill: Skill) => {
      // Insert `/<command> ` into the input and close the menu. We DO NOT
      // submit here — the user may want to append free-form context (e.g.
      // "/one-pager focus on cash conversion") before hitting Enter. The
      // expansion to the full skill prompt happens at submit time in
      // handleSubmit() so the user gets one final review beat.
      setChatInput(skill.command + " ");
      setSlashDismissed(true);
      setSlashIdx(0);
      setPendingCaretToEnd(true);
    },
    [setChatInput],
  );

  // Move the caret to the end of the textarea after a pickSkill insert.
  // useEffect fires after React commits the new value, so .value.length
  // reflects the inserted `/<command> ` and the user can keep typing.
  useEffect(() => {
    if (!pendingCaretToEnd) return;
    const el = textareaRef.current;
    if (el) {
      const len = el.value.length;
      el.focus();
      el.setSelectionRange(len, len);
    }
    setPendingCaretToEnd(false);
  }, [pendingCaretToEnd, chatInput]);

  // Submit path — expands a `/<command> ...` input into the full skill
  // prompt (with any trailing text appended as analyst context), then
  // routes through onSendPrompt so we don't have to round-trip the
  // expanded prompt back through chatInput state. Plain inputs (no
  // matching command) fall through to the existing onSend path.
  const handleSubmit = useCallback(() => {
    if (chatSending) return;
    const raw = chatInput;
    if (!raw.trim()) return;
    const match = findSkillCommand(raw);
    if (match && deal) {
      const expanded = expandChatInput(raw, deal);
      setChatInput("");
      onSendPrompt(expanded);
      return;
    }
    onSend();
  }, [chatInput, chatSending, deal, onSend, onSendPrompt, setChatInput]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the slash menu is visible, ArrowUp/Down/Enter/Escape belong to
    // the menu — never to the textarea. The menu has no focus of its own
    // (the textarea keeps it for typing), so we own the keyboard here.
    if (slashMenuVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setSlashIdx((i) => Math.min(i + 1, filteredSkills.length - 1));
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredSkills.length > 0) {
          setSlashIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const sel = filteredSkills[slashIdx];
        if (sel) {
          pickSkill(sel);
        }
        // If filteredSkills is empty, Enter is a no-op while the menu is
        // visible — the user should either keep typing or press Esc.
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
      // Other keys (typing) fall through so the user can refine the query.
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleFileAttach = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !deal) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Validate size (25MB max)
    if (file.size > 25 * 1024 * 1024) return;

    const entry = { name: file.name, status: "uploading" as const };
    setAttachedFiles((prev) => [...prev, entry]);

    try {
      const formData = new FormData();
      formData.append("file", file);

      // authFetchRaw forwards the Supabase Bearer token; bare fetch returned
      // 401 because the API auth middleware never saw the JWT.
      const res = await authFetchRaw(`/deals/${deal.id}/documents`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");

      setAttachedFiles((prev) =>
        prev.map((f) => (f.name === file.name && f.status === "uploading" ? { ...f, status: "done" } : f))
      );
    } catch (err) {
      console.warn("[deal-tabs] chat file attach failed:", err);
      setAttachedFiles((prev) =>
        prev.map((f) => (f.name === file.name && f.status === "uploading" ? { ...f, status: "error" } : f))
      );
    }
  }, [deal]);

  const removeAttached = (name: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.name !== name));
  };

  const documents = deal?.documents || [];

  return (
    <>
      <div className="flex flex-col overflow-hidden h-full">
        {/* Header — matches legacy chat header */}
        <div className="h-12 border-b border-border-subtle flex items-center justify-between px-4 bg-surface-card/80 backdrop-blur z-20 sticky top-0">
          <div className="flex items-center gap-2">
            <div className="size-2 rounded-full bg-secondary animate-pulse" />
            <span className="text-sm font-bold text-text-main tracking-wide">Deal Assistant AI</span>
            <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-primary-light text-primary border border-primary/20">
              Beta
            </span>
          </div>
          <div className="flex items-center gap-3">
            <ContextDocIndicators documents={documents} />
            <button
              onClick={() => setShowClearModal(true)}
              className="text-text-muted hover:text-red-500 transition-colors"
              title="Clear chat history"
            >
              <span className="material-symbols-outlined text-lg">delete_sweep</span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="text-text-muted hover:text-text-main transition-colors"
              title="AI settings"
            >
              <span className="material-symbols-outlined text-lg">settings</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 flex flex-col custom-scrollbar">
          {/* Welcome message when no history (matches legacy ai-intro-message) */}
          {messages.length === 0 && (
            <div className="ai-intro-message flex gap-4 max-w-[90%]">
              <div className="size-8 rounded-lg bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shrink-0 shadow-md shadow-primary/20">
                <span className="material-symbols-outlined text-white text-lg">smart_toy</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-text-muted ml-1">Avise AI</span>
                <div className="ai-bubble-gradient border border-border-subtle rounded-2xl rounded-tl-none p-4 text-sm text-text-secondary shadow-sm">
                  {deal?.aiThesis ? (
                    <>
                      <p>I&apos;ve analyzed the documents for <strong>{deal.name}</strong>. {deal.aiThesis}</p>
                      <p className="mt-2">What would you like to know about this deal?</p>
                    </>
                  ) : (
                    <>
                      <p>I&apos;m ready to help analyze this deal. Ask me about financials, risks, or any uploaded documents.</p>
                      <p className="mt-2">What would you like to know?</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg) =>
            msg.role === "user" ? (
              /* User message — matches legacy addUserMessage / addUserMessageFromHistory */
              <div key={msg.id} className="flex gap-4 max-w-[80%] self-end flex-row-reverse animate-fadeIn">
                <div className="size-8 rounded-full bg-[#003366] border border-white shrink-0 flex items-center justify-center shadow-sm">
                  <span className="text-[11px] text-white font-bold">U</span>
                </div>
                <div className="flex flex-col gap-1 items-end">
                  <span className="text-xs font-bold text-text-muted mr-1">You</span>
                  <div className="bg-white text-text-main border border-border-subtle rounded-2xl rounded-tr-none p-4 text-sm shadow-sm">
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  </div>
                </div>
              </div>
            ) : (
              /* AI message — matches legacy addAIResponseFromAPI / addAIResponseFromHistory */
              <div key={msg.id} className="flex gap-4 max-w-[90%] animate-fadeIn">
                <div className="size-8 rounded-lg bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shrink-0 shadow-md shadow-primary/20">
                  <span className="material-symbols-outlined text-white text-lg">smart_toy</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-text-muted ml-1">Avise AI</span>
                  <div className="ai-bubble-gradient border border-border-subtle rounded-2xl rounded-tl-none p-4 text-sm text-text-secondary shadow-sm">
                    <AiMessageBody content={msg.content} />
                    {msg.action && msg.action.url && msg.action.label && (
                      <ArtifactActionButton action={msg.action} />
                    )}
                  </div>
                  {/* Helpful / Copy buttons — hidden while the message is still streaming in */}
                  {!msg.streaming && <AIMessageActions content={msg.content} />}
                </div>
              </div>
            )
          )}

          {/* Typing indicator */}
          {chatSending && (
            <div className="flex gap-4 max-w-[90%] animate-fadeIn">
              <div className="size-8 rounded-lg bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shrink-0 shadow-md shadow-primary/20">
                <span className="material-symbols-outlined text-white text-lg">smart_toy</span>
              </div>
              <div className="flex flex-col gap-1 justify-center">
                <div className="bg-white border border-border-subtle rounded-2xl rounded-tl-none px-4 py-3 text-sm text-text-secondary shadow-sm w-16">
                  <div className="flex gap-1">
                    <div className="size-1.5 bg-text-muted rounded-full animate-bounce" />
                    <div className="size-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0.1s" }} />
                    <div className="size-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0.2s" }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Suggestion chips — always visible above the input (per cf67cea) */}
        <SuggestionChips deal={deal} onPick={onSendPrompt} />

        {/* Input area with attachment support */}
        <div className="p-3 bg-surface-card border-t-0 relative z-30">
          {/* Attached file chips */}
          {attachedFiles.length > 0 && (
            <div className="flex gap-2 mb-3 overflow-x-auto custom-scrollbar">
              {attachedFiles.map((f) => (
                <div
                  key={f.name}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs",
                    f.status === "uploading" && "bg-primary-light border border-primary/20",
                    f.status === "done" && "bg-primary-light border border-primary/20",
                    f.status === "error" && "bg-red-50 border border-red-200"
                  )}
                >
                  <span className={cn(
                    "material-symbols-outlined text-sm",
                    f.status === "uploading" && "text-primary animate-spin",
                    f.status === "done" && "text-green-600",
                    f.status === "error" && "text-red-500"
                  )}>
                    {f.status === "uploading" ? "sync" : f.status === "done" ? "check_circle" : "error"}
                  </span>
                  <span className="text-text-secondary font-medium truncate max-w-[150px]">{f.name}</span>
                  {f.status !== "uploading" && (
                    <button
                      onClick={() => removeAttached(f.name)}
                      className="text-text-muted hover:text-red-500 transition-colors ml-1"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="relative bg-background-body rounded-xl border border-border-subtle shadow-inner">
            {slashMenuVisible && (
              <SlashMenu
                deal={deal}
                skills={filteredSkills}
                selectedIdx={slashIdx}
                onHoverIndex={setSlashIdx}
                onPick={pickSkill}
              />
            )}
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => {
                setChatInput(e.target.value);
                // Any edit re-arms the menu — Escape's "dismissed" flag
                // only sticks until the user touches the field again.
                // EXCEPT when the input still starts with a known skill
                // command (the user picked from the menu and is now
                // typing extra context); in that case keep it dismissed
                // so the menu doesn't pop back over their typing.
                if (slashDismissed && !findSkillCommand(e.target.value)) {
                  setSlashDismissed(false);
                }
              }}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent border-none text-text-main placeholder:text-text-muted px-4 py-3 pr-24 focus:ring-0 resize-none min-h-[50px] max-h-32 text-sm leading-relaxed"
              placeholder="Ask about the deal, or type / for commands..."
              rows={1}
              aria-autocomplete="list"
              aria-expanded={slashMenuVisible}
              aria-controls={slashMenuVisible ? "dealchat-slash-menu" : undefined}
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.txt"
                onChange={handleFileAttach}
              />
              {/* Attach button is always rendered — the previous
                  `textareaFocused || hasFiles` gate caused a click race:
                  mousedown on the button blurred the textarea, the parent
                  re-rendered without the button, and the click event
                  never landed. onMouseDown + preventDefault belt-and-
                  suspenders so focus doesn't shuffle if the textarea is
                  active. */}
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }}
                className="p-1.5 text-text-muted hover:text-primary hover:bg-primary-light rounded-lg transition-colors"
                title="Attach File"
                aria-label="Attach File"
              >
                <span className="material-symbols-outlined text-[20px]">attach_file</span>
              </button>
              <button
                onClick={handleSubmit}
                disabled={!chatInput.trim() || chatSending}
                className="p-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors shadow-md shadow-primary/30 disabled:opacity-40"
                title="Send Message"
              >
                <span className="material-symbols-outlined text-[20px]">arrow_upward</span>
              </button>
            </div>
          </div>
          <div className="text-center mt-2">
            <p className="text-[10px] text-text-muted">
              AI can make mistakes. Verify critical data from original documents.
            </p>
          </div>
        </div>
      </div>

      {/* Clear Chat Confirmation Modal */}
      {showClearModal && (
        <ClearChatModal
          onConfirm={() => {
            setShowClearModal(false);
            onClearChat?.();
          }}
          onCancel={() => setShowClearModal(false)}
        />
      )}

      {/* AI Settings Modal */}
      {showSettings && <AISettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity Tab — re-export from deal-tabs-activity.tsx (split for file size)
// ---------------------------------------------------------------------------

export { ActivityTab } from "./deal-tabs-activity";
