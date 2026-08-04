"use client";

import { useState, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import { cn } from "@/lib/cn";
import { renderMarkdown } from "@/lib/markdown";
import type { ChatMessage, DealDetail } from "./components";
import { ClearChatModal } from "./components";
import { AISettingsModal } from "./deal-panels";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { SuggestionChips } from "./deal-tabs-suggestions";
import { ContextDocIndicators } from "./deal-tabs-context-indicators";
import { AIMessageActions } from "./deal-tabs-ai-message-actions";
import { ArtifactActionButton } from "./deal-tabs-artifact-button";

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
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; status: "uploading" | "done" | "error" }>>([]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
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
                <span className="text-xs font-bold text-text-muted ml-1">PE OS AI</span>
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
                  <span className="text-xs font-bold text-text-muted ml-1">PE OS AI</span>
                  <div className="ai-bubble-gradient border border-border-subtle rounded-2xl rounded-tl-none p-4 text-sm text-text-secondary shadow-sm">
                    <div
                      className="chat-markdown space-y-1 break-words [&_p]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:mb-0.5 [&_strong]:font-semibold"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(msg.content)) }}
                    />
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
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent border-none text-text-main placeholder:text-text-muted px-4 py-3 pr-24 focus:ring-0 resize-none min-h-[50px] max-h-32 text-sm leading-relaxed"
              placeholder="Ask about the deal, financials, or risks..."
              rows={1}
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
                onClick={onSend}
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
