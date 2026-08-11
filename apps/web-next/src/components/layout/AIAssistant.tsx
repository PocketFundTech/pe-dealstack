"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { api, NotFoundError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import {
  buildHistoryPayload,
  detectContext,
  getWelcomeMessage,
  isMutationAction,
  isNavigateAction,
  streamChat,
  type Action,
  type ChatContext,
  type ChatMessage,
  type ChatResponse,
  type ContextType,
  type MutationPayload,
} from "./ai-assistant-shared";
import { AIAssistantDrawer } from "./AIAssistantDrawer";

// ── Persistence ──────────────────────────────────────────────────────────────
// Per-context history bucket so deal/portfolio/contacts/memo conversations
// don't bleed into each other when the user moves between pages.

const MAX_PERSISTED_MESSAGES = 40;

type HistoryStore = Partial<Record<ContextType, ChatMessage[]>>;

function historyKey(): string {
  return STORAGE_KEYS.aiAssistantHistory;
}

function loadHistory(ctx: ChatContext): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(historyKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryStore;
    const bucket = parsed?.[ctx.type];
    if (!Array.isArray(bucket)) return [];
    return bucket.filter(
      (m) =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch (err) {
    console.warn("[layout/AIAssistant] failed to load chat history:", err);
    return [];
  }
}

function saveHistory(ctx: ChatContext, messages: ChatMessage[]) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(historyKey());
    const parsed: HistoryStore = raw ? JSON.parse(raw) : {};
    parsed[ctx.type] = messages.slice(-MAX_PERSISTED_MESSAGES);
    window.localStorage.setItem(historyKey(), JSON.stringify(parsed));
  } catch (err) {
    // Quota or parse error — history is best-effort.
    console.warn("[layout/AIAssistant] failed to save chat history:", err);
  }
}

// Friendly progress labels for known tool names. Unknown tools fall back to a
// title-cased version so the indicator is never empty.
const TOOL_LABELS: Record<string, string> = {
  searchDocuments: "Searching documents",
  searchDeals: "Searching deals",
  searchContacts: "Searching contacts",
  getDeal: "Loading deal",
  getPortfolio: "Reading portfolio",
  draftEmail: "Drafting email",
  webSearch: "Searching the web",
};

function toolLabel(tool: string): string {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  // camelCase → spaced, capitalised first word.
  const spaced = tool.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ── FAB style (drawer styles live in AIAssistantDrawer.tsx) ──────────────────

const fabStyle: CSSProperties = {
  position: "fixed", bottom: 84, right: 24, zIndex: 9970,
  width: 52, height: 52, borderRadius: 16,
  background: "#003366", color: "#fff", border: "none",
  boxShadow: "0 4px 16px rgba(0,51,102,0.35), 0 0 0 0 rgba(0,51,102,0.2)",
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
};

// Routes where the global FAB+drawer should not render. Deal-detail pages
// have their own integrated chat panel, the data-room renders its own header,
// and unauth pages obviously shouldn't surface the assistant.
function isHiddenRoute(pathname: string): boolean {
  if (/^\/deals\/[^/]+$/.test(pathname)) return true;
  if (/^\/data-room\/[^/]/.test(pathname)) return true;
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/onboarding") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/accept-invite") ||
    pathname.startsWith("/verify-email")
  ) return true;
  return false;
}

// ── Component ────────────────────────────────────────────────────────────────

export function AIAssistant() {
  const pathname = usePathname();
  const params = useParams();
  const router = useRouter();
  const { showToast } = useToast();

  const context = useMemo<ChatContext>(
    () => detectContext(pathname, params as Record<string, string | string[] | undefined>),
    [pathname, params],
  );

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [fabHover, setFabHover] = useState(false);
  // Transient label for in-flight tool activity (e.g. "Searching documents…").
  // null when no tool is running.
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  // True once the first token of a streamed reply has landed — lets the drawer
  // swap the typing dots for the live assistant bubble.
  const [isStreaming, setIsStreaming] = useState(false);

  // Track which context's history is currently loaded so we re-hydrate when
  // the user navigates between contexts while the drawer is open.
  const loadedCtxRef = useRef<ContextType | null>(null);
  const hidden = isHiddenRoute(pathname);

  // Hydrate messages for the active context (load persisted history, prepend
  // welcome if empty). Runs whenever context.type changes.
  useEffect(() => {
    if (loadedCtxRef.current === context.type) return;
    const persisted = loadHistory(context);
    if (persisted.length > 0) {
      setMessages(persisted);
    } else {
      setMessages([{ role: "assistant", content: getWelcomeMessage(context) }]);
    }
    loadedCtxRef.current = context.type;
  }, [context]);

  // Persist on every change (cheap; bucket is small).
  useEffect(() => {
    if (loadedCtxRef.current !== context.type) return;
    saveHistory(context, messages);
  }, [messages, context]);

  // Keyboard shortcuts: Shift+Space toggle, Escape close.
  const toggleDrawer = useCallback(() => setIsOpen((v) => !v), []);
  const openDrawer = useCallback(() => setIsOpen(true), []);
  const closeDrawer = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.shiftKey &&
        e.code === "Space" &&
        !isTypingTarget(document.activeElement)
      ) {
        e.preventDefault();
        // Don't open the AI drawer when a modal overlay is active.
        if (!isOpen && document.querySelector("[data-modal-overlay]")) return;
        toggleDrawer();
      }
      if (e.key === "Escape" && isOpen) closeDrawer();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggleDrawer, isOpen, closeDrawer]);

  // ── Send message ───────────────────────────────────────────────────────────

  // Replace the last (in-progress) assistant bubble. Used to append streamed
  // tokens and to write the final text/actions or an error message.
  const updateLastAssistant = useCallback(
    (mutate: (prev: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        if (prev.length === 0 || prev[prev.length - 1].role !== "assistant") return prev;
        const next = prev.slice();
        next[next.length - 1] = mutate(next[next.length - 1]);
        return next;
      });
    },
    [],
  );

  // Non-streaming fallback: hit the plain /ai/chat endpoint and write the
  // result (text + actions) into the placeholder assistant bubble.
  const runFallback = useCallback(
    async (trimmed: string, priorMessages: ChatMessage[]) => {
      const data = await api.post<ChatResponse>("/ai/chat", {
        message: trimmed,
        context: context.type,
        history: buildHistoryPayload(priorMessages),
      });
      const rawText =
        data.response || data.message || data.reply || data.content ||
        "I received your message but couldn't generate a response.";
      const aiText =
        typeof rawText === "string"
          ? rawText
          : (rawText as unknown as { message?: string; error?: string })?.message ??
            (rawText as unknown as { message?: string; error?: string })?.error ??
            JSON.stringify(rawText);
      updateLastAssistant((m) => ({
        ...m,
        content: aiText,
        actions: Array.isArray(data.actions) ? data.actions : undefined,
      }));
    },
    [context.type, updateLastAssistant],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      // Capture the conversation so far (before this turn) for memory, then
      // append the new user message AND an empty assistant placeholder we
      // stream into. The functional updater gives us the live list even though
      // `messages` in this closure may be stale.
      let priorMessages: ChatMessage[] = [];
      setMessages((prev) => {
        priorMessages = prev;
        return [
          ...prev,
          { role: "user", content: trimmed },
          { role: "assistant", content: "" },
        ];
      });
      setIsLoading(true);
      setIsStreaming(false);
      setToolActivity(null);

      // The per-deal branch keeps its existing non-streaming behaviour.
      if (context.type === "deal" && context.dealId) {
        try {
          const data = await api.post<ChatResponse>(`/deals/${context.dealId}/chat`, {
            message: trimmed,
          });
          const rawText =
            data.response || data.message || data.reply || data.content ||
            "I received your message but couldn't generate a response.";
          const aiText =
            typeof rawText === "string"
              ? rawText
              : (rawText as unknown as { message?: string })?.message ?? JSON.stringify(rawText);
          updateLastAssistant((m) => ({ ...m, content: aiText }));
        } catch (err) {
          const errContent =
            err instanceof NotFoundError
              ? "The AI assistant service isn't available yet. Please check back soon."
              : "Sorry, I couldn't connect to the AI service. Please check your connection and try again.";
          updateLastAssistant((m) => ({ ...m, content: errContent }));
        } finally {
          setIsLoading(false);
          setIsStreaming(false);
          setToolActivity(null);
        }
        return;
      }

      // Global / non-deal path: try streaming, fall back to /ai/chat.
      let streamSucceeded = false;
      let streamProducedText = false;
      let streamErrored = false;
      try {
        const ok = await streamChat(
          {
            message: trimmed,
            context: context.type,
            history: buildHistoryPayload(priorMessages),
          },
          {
            onToken: (tok) => {
              streamProducedText = true;
              setIsStreaming(true);
              setToolActivity(null);
              updateLastAssistant((m) => ({ ...m, content: m.content + tok }));
            },
            onTool: (tool, status) => {
              setToolActivity(status === "running" ? `${toolLabel(tool)}…` : null);
            },
            onDone: (full, actions) => {
              streamSucceeded = true;
              setToolActivity(null);
              updateLastAssistant((m) => ({
                ...m,
                // Prefer the authoritative full text; fall back to accumulated.
                content: full || m.content,
                actions: actions.length > 0 ? actions : undefined,
              }));
            },
            onError: (message) => {
              streamErrored = true;
              setToolActivity(null);
              updateLastAssistant((m) => ({
                ...m,
                content: message || "Sorry, the assistant hit an error.",
              }));
            },
          },
        );
        // streamChat returns false when the body isn't streamable → fall back.
        if (!ok) {
          await runFallback(trimmed, priorMessages);
          streamSucceeded = true;
        }
      } catch (streamErr) {
        // The stream request couldn't be established (network, unauthorized
        // already redirects). If a server `error` event already wrote a
        // message, leave it; otherwise try the non-streaming endpoint so the
        // user is never left with a dead spinner.
        if (!streamErrored && !streamProducedText) {
          try {
            await runFallback(trimmed, priorMessages);
            streamSucceeded = true;
          } catch (fallbackErr) {
            const errContent =
              fallbackErr instanceof NotFoundError
                ? "The AI assistant service isn't available yet. Please check back soon."
                : "Sorry, I couldn't connect to the AI service. Please check your connection and try again.";
            updateLastAssistant((m) => ({ ...m, content: errContent }));
          }
        } else {
          console.warn("[layout/AIAssistant] stream ended with error:", streamErr);
        }
      } finally {
        // If the stream ended without a `done`/`error`/token and without
        // falling back (e.g. empty stream), surface a graceful message rather
        // than an empty bubble.
        if (!streamSucceeded && !streamErrored && !streamProducedText) {
          updateLastAssistant((m) =>
            m.content
              ? m
              : { ...m, content: "I couldn't generate a response. Please try again." },
          );
        }
        setIsLoading(false);
        setIsStreaming(false);
        setToolActivity(null);
      }
    },
    [isLoading, context, updateLastAssistant, runFallback],
  );

  // ── Action execution ─────────────────────────────────────────────────────
  // navigate → router push (inert), draftEmail → handled in the drawer (copy),
  // mutations → confirmed then POST/PATCH the given endpoint with toast feedback.

  const executeMutation = useCallback(
    async (action: Action) => {
      if (!isMutationAction(action)) return;
      const payload = action.payload as MutationPayload;
      try {
        if (payload.method === "patch") {
          await api.patch(payload.endpoint, payload.body ?? {});
        } else {
          await api.post(payload.endpoint, payload.body ?? {});
        }
        showToast(action.label, "success", { title: "Done" });
      } catch (err) {
        const message =
          err instanceof NotFoundError
            ? "That action isn't available yet."
            : err instanceof Error
              ? err.message
              : "The action failed. Please try again.";
        showToast(message, "error", { title: "Action failed" });
      }
    },
    [showToast],
  );

  const handleNavigate = useCallback(
    (href: string) => {
      router.push(href);
      closeDrawer();
    },
    [router, closeDrawer],
  );

  const handleCopyDraft = useCallback(
    (textToCopy: string) => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard
          .writeText(textToCopy)
          .then(() => showToast("Draft copied to clipboard", "success"))
          .catch((err) => {
            console.warn("[layout/AIAssistant] clipboard write failed:", err);
            showToast("Couldn't copy — select and copy manually.", "warning");
          });
      } else {
        showToast("Clipboard unavailable — select and copy manually.", "warning");
      }
    },
    [showToast],
  );

  // Stable wrapper so the drawer can treat navigate as an action click too.
  const handleActionClick = useCallback(
    (action: Action) => {
      if (isNavigateAction(action)) handleNavigate(action.payload.href);
    },
    [handleNavigate],
  );

  const handleSend = useCallback(() => {
    const text = inputValue;
    setInputValue("");
    void send(text);
  }, [inputValue, send]);

  const handleSendPrompt = useCallback(
    (prompt: string) => {
      setInputValue("");
      void send(prompt);
    },
    [send],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  if (hidden) return null;

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          onClick={openDrawer}
          onMouseEnter={() => setFabHover(true)}
          onMouseLeave={() => setFabHover(false)}
          title="Ask AI (Shift+Space)"
          aria-label="Open AI Assistant"
          className="ai-fab-btn"
          style={{
            ...fabStyle,
            ...(fabHover
              ? { transform: "scale(1.08)", boxShadow: "0 6px 24px rgba(0,51,102,0.4)" }
              : {}),
          }}
        >
          <span className="material-symbols-outlined text-2xl">auto_awesome</span>
        </button>
      )}

      {isOpen && (
        <AIAssistantDrawer
          context={context}
          messages={messages}
          isLoading={isLoading}
          isStreaming={isStreaming}
          toolActivity={toolActivity}
          inputValue={inputValue}
          setInputValue={setInputValue}
          onClose={closeDrawer}
          onSend={handleSend}
          onSendPrompt={handleSendPrompt}
          onActionClick={handleActionClick}
          onConfirmMutation={executeMutation}
          onCopyDraft={handleCopyDraft}
        />
      )}
    </>
  );
}
