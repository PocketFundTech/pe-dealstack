// Shared types + helpers for the global AI Assistant FAB/drawer.

import { createClient } from "@/lib/supabase/client";

export type ContextType = "deal" | "dashboard" | "contacts" | "deals" | "memo" | "general";

export interface ChatContext {
  type: ContextType;
  dealId?: string;
  dealName?: string;
}

export interface ChatMessage {
  role: "assistant" | "user";
  content: string;
  /**
   * Proposed actions attached to an assistant turn (navigate / draftEmail /
   * mutation chips). Only ever set on assistant messages. Persisted so chips
   * survive a reload, but a confirmed/executed mutation is best-effort — the
   * user can re-confirm if they reload mid-flight.
   */
  actions?: Action[];
}

// ── Assistant actions (proposed by the backend, executed client-side) ────────
// Contract shared with the API. `navigate` and `draftEmail` are inert (no
// server call); mutations carry `needsConfirm: true` and an endpoint to hit.

export type ActionType =
  | "navigate"
  | "draftEmail"
  | "createTask"
  | "changeStage"
  | "addNote";

export interface NavigatePayload {
  href: string;
}

export interface DraftEmailPayload {
  to?: string;
  subject?: string;
  body: string;
}

export interface MutationPayload {
  endpoint: string;
  method: "post" | "patch";
  body?: Record<string, unknown>;
}

export interface Action {
  type: ActionType;
  label: string;
  needsConfirm: boolean;
  payload: NavigatePayload | DraftEmailPayload | MutationPayload | Record<string, unknown>;
}

export function isNavigateAction(
  a: Action,
): a is Action & { payload: NavigatePayload } {
  return a.type === "navigate" && typeof (a.payload as NavigatePayload)?.href === "string";
}

export function isDraftEmailAction(
  a: Action,
): a is Action & { payload: DraftEmailPayload } {
  return a.type === "draftEmail" && typeof (a.payload as DraftEmailPayload)?.body === "string";
}

export function isMutationAction(
  a: Action,
): a is Action & { payload: MutationPayload } {
  const p = a.payload as MutationPayload;
  return (
    (a.type === "createTask" || a.type === "changeStage" || a.type === "addNote") &&
    typeof p?.endpoint === "string" &&
    (p?.method === "post" || p?.method === "patch")
  );
}

// How many recent turns to send to the backend as conversation memory.
// The backend re-caps this (last ~8 turns / bounded chars); we send a small
// window to keep the request light.
export const MAX_HISTORY_TURNS_SENT = 8;

/**
 * Build the bounded `history` payload for an /ai/chat request from the local
 * message list. Excludes the just-sent user message (caller passes the list
 * BEFORE appending it), drops the synthetic welcome message, and caps to the
 * most recent MAX_HISTORY_TURNS_SENT turns.
 */
export function buildHistoryPayload(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS_SENT)
    .map((m) => ({ role: m.role, content: m.content }));
}

export interface ChatResponse {
  response?: string;
  message?: string;
  reply?: string;
  content?: string;
  error?: string;
  model?: string;
  actions?: Action[];
}

export interface SuggestedPrompt {
  icon: string;
  label: string;
  prompt: string;
}

// ── Context detection ────────────────────────────────────────────────────────

/** Detect chat context purely from pathname + already-known params/dealId. */
export function detectContext(
  pathname: string,
  params?: Record<string, string | string[] | undefined>,
): ChatContext {
  // /deals/[id] — deal detail page
  const dealMatch = pathname.match(/^\/deals\/([^/]+)$/);
  if (dealMatch && dealMatch[1] !== "new") {
    const id =
      typeof params?.id === "string"
        ? params.id
        : Array.isArray(params?.id)
          ? params.id[0]
          : dealMatch[1];
    return { type: "deal", dealId: id };
  }
  // Treat `/` as the portfolio dashboard so the assistant has useful context
  // even before the user navigates to /dashboard.
  if (pathname === "/" || pathname.startsWith("/dashboard")) return { type: "dashboard" };
  if (pathname.startsWith("/contacts")) return { type: "contacts" };
  if (pathname.startsWith("/memo-builder")) return { type: "memo" };
  if (pathname.startsWith("/deals")) return { type: "deals" };
  return { type: "general" };
}

// ── Context-derived UI strings ───────────────────────────────────────────────

export function getContextIcon(ctx: ChatContext): string {
  switch (ctx.type) {
    case "deal": return "work";
    case "dashboard": return "dashboard";
    case "contacts": return "groups";
    case "deals": return "filter_alt";
    case "memo": return "description";
    default: return "auto_awesome";
  }
}

export function getContextLabel(ctx: ChatContext): string {
  switch (ctx.type) {
    case "deal": return ctx.dealName || "Deal";
    case "dashboard": return "Portfolio";
    case "contacts": return "Contacts";
    case "deals": return "Deal Pipeline";
    case "memo": return "Memo";
    default: return "General";
  }
}

export function getPlaceholder(ctx: ChatContext): string {
  switch (ctx.type) {
    case "deal": return `Ask about ${ctx.dealName || "this deal"}...`;
    case "dashboard": return "Ask about your portfolio...";
    case "contacts": return "Ask about relationships...";
    case "deals": return "Ask about your deal pipeline...";
    case "memo": return "Ask about this memo...";
    default: return "Ask AI anything...";
  }
}

export function getWelcomeMessage(ctx: ChatContext): string {
  switch (ctx.type) {
    case "deal":
      return `I have full context on **${ctx.dealName || "this deal"}** — financials, documents, team, and activity. What would you like to know?`;
    case "dashboard":
      return "I can help you analyze your portfolio, spot trends, and surface insights across all your deals. What would you like to explore?";
    case "contacts":
      return "I can help with relationship insights, suggest follow-ups, and analyze your network. What do you need?";
    case "deals":
      return "I can help analyze your deal pipeline, compare deals, and identify patterns. What are you looking for?";
    case "memo":
      return "I can help draft, refine, and review your investment memo. What section do you want to work on?";
    default:
      return "Hi! I'm your AI assistant. Ask me anything about your deals, portfolio, or contacts.";
  }
}

// ── Per-context suggested prompt chips (3-4 each) ────────────────────────────

const PROMPTS_BY_CONTEXT: Record<ContextType, SuggestedPrompt[]> = {
  deal: [
    { icon: "warning", label: "Key risks & red flags", prompt: "What are the biggest risks and red flags for this deal? Pull specific data points from the documents." },
    { icon: "analytics", label: "Financial health check", prompt: "Analyze the financial health of this company. What do revenue, margins, and cash flow tell us?" },
    { icon: "lightbulb", label: "Investment thesis", prompt: "Write a 3-paragraph investment thesis covering: why it's attractive, value-creation levers, and key risks with mitigants." },
    { icon: "checklist", label: "DD questions", prompt: "Generate 10 targeted due diligence questions for management, organized by category (financial, operational, legal, commercial)." },
  ],
  dashboard: [
    { icon: "trending_up", label: "Top performers", prompt: "Which deals in my portfolio are performing best right now? Compare returns and growth across the active deals." },
    { icon: "warning", label: "Portfolio risks", prompt: "What are the biggest risks across my portfolio? Surface concentration risk, sector exposure, and underperformers." },
    { icon: "speed", label: "Pipeline velocity", prompt: "How is my deal pipeline moving? Show me stage conversion rates and where deals are stuck." },
    { icon: "summarize", label: "Weekly summary", prompt: "Give me a one-page summary of portfolio activity this week: new deals, stage changes, and notable updates." },
  ],
  deals: [
    { icon: "filter_alt", label: "Compare top deals", prompt: "Compare my top 5 active deals side-by-side on revenue, EBITDA, valuation, and stage." },
    { icon: "warning", label: "Stuck deals", prompt: "Which deals have been in the same stage for too long? Suggest next steps for each." },
    { icon: "search", label: "Deals by sector", prompt: "Group my pipeline by industry and show me where I'm most concentrated." },
    { icon: "schedule", label: "Upcoming actions", prompt: "What deal-related actions need attention this week? List by urgency." },
  ],
  contacts: [
    { icon: "person_add", label: "Suggest follow-ups", prompt: "Which contacts should I follow up with this week? Prioritize warm relationships I haven't touched recently." },
    { icon: "hub", label: "Network insights", prompt: "Analyze my network. Who are my strongest connections, and where are the gaps?" },
    { icon: "diversity_3", label: "Intro opportunities", prompt: "Suggest valuable introductions I could make between people in my network." },
    { icon: "contact_mail", label: "Draft outreach", prompt: "Help me draft a warm outreach email to a key contact. Ask me who and what the context is." },
  ],
  memo: [
    { icon: "edit_note", label: "Improve writing", prompt: "Review the current memo section and tighten the writing — more concise, more specific, more punchy." },
    { icon: "fact_check", label: "Sanity-check facts", prompt: "Sanity-check the figures and claims in this memo. Flag anything that looks inconsistent or unsupported." },
    { icon: "format_list_bulleted", label: "Outline section", prompt: "Help me outline the next section of this memo with key bullet points and supporting data." },
    { icon: "compare_arrows", label: "Counterargument", prompt: "Make the strongest counterargument against the investment thesis in this memo. What would a skeptic say?" },
  ],
  general: [
    { icon: "tips_and_updates", label: "What can you do?", prompt: "What kinds of questions can you help me with across deals, portfolio, contacts, and memos?" },
    { icon: "search", label: "Find a deal", prompt: "Help me find a deal — I'll describe what I'm looking for and you suggest matches in my pipeline." },
    { icon: "school", label: "PE concept primer", prompt: "Explain a PE concept I should know better. Ask me which one." },
    { icon: "auto_awesome", label: "Quick brainstorm", prompt: "I want to brainstorm something. Help me think it through step by step." },
  ],
};

export function getSuggestedPrompts(ctx: ChatContext): SuggestedPrompt[] {
  return PROMPTS_BY_CONTEXT[ctx.type] ?? PROMPTS_BY_CONTEXT.general;
}

// ── Streaming chat (SSE over fetch) ──────────────────────────────────────────
// We use fetch + ReadableStream rather than EventSource because the endpoint
// needs POST (message/context/history body) AND an Authorization header, which
// EventSource can't send. Auth-header derivation mirrors lib/api.ts so we stay
// in sync with how every other request authenticates.

const STREAM_PATH = "/api/ai/chat/stream";

async function streamAuthHeaders(): Promise<HeadersInit> {
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { "Content-Type": "application/json" };
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface StreamCallbacks {
  /** Incremental assistant text — append to the in-progress bubble. */
  onToken: (text: string) => void;
  /** Tool activity — show/hide a transient indicator. */
  onTool: (tool: string, status: "running" | "done") => void;
  /** Final payload — finalize text + stash actions. */
  onDone: (full: string, actions: Action[], model?: string) => void;
  /** Server-emitted error event. */
  onError: (message: string) => void;
}

export interface StreamRequest {
  message: string;
  context: ContextType;
  history: ChatMessage[];
}

/**
 * POST to the streaming chat endpoint and drive the callbacks as SSE events
 * arrive. Resolves `true` once the stream has been consumed end-to-end (the
 * caller should NOT fall back). Resolves `false` when the response isn't
 * streamable (non-OK status or missing body) — the caller should then fall
 * back to the non-streaming endpoint. Throws if the request can't be
 * established (network error); the caller's catch handles fallback there too.
 *
 * SSE framing: events are separated by a blank line. Within an event block we
 * read `event:` and `data:` lines; `data:` may span multiple lines (joined with
 * "\n" per the spec). On a blank line we dispatch the accumulated event.
 */
export async function streamChat(
  req: StreamRequest,
  cb: StreamCallbacks,
): Promise<boolean> {
  const headers = await streamAuthHeaders();
  const res = await fetch(STREAM_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok || !res.body) {
    // Not streamable (404, 5xx, or no body) — signal fallback.
    return false;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (rawEvent: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) continue; // SSE comment / heartbeat
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return;
    const dataStr = dataLines.join("\n");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      // Malformed data line — skip rather than crash the stream loop.
      return;
    }

    switch (eventName) {
      case "token": {
        const text = typeof data.text === "string" ? data.text : "";
        if (text) cb.onToken(text);
        break;
      }
      case "tool": {
        const tool = typeof data.tool === "string" ? data.tool : "";
        const status = data.status === "done" ? "done" : "running";
        if (tool) cb.onTool(tool, status);
        break;
      }
      case "done": {
        const full = typeof data.response === "string" ? data.response : "";
        const actions = Array.isArray(data.actions) ? (data.actions as Action[]) : [];
        const model = typeof data.model === "string" ? data.model : undefined;
        cb.onDone(full, actions, model);
        break;
      }
      case "error": {
        const message =
          typeof data.message === "string" ? data.message : "The assistant hit an error.";
        cb.onError(message);
        break;
      }
      default:
        break;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split on blank line (event boundary). Normalise CRLF first.
    let idx: number;
    buffer = buffer.replace(/\r\n/g, "\n");
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (rawEvent.trim()) dispatch(rawEvent);
    }
  }

  // Flush any trailing event without a terminating blank line.
  const tail = buffer.trim();
  if (tail) dispatch(tail);

  // The stream was consumed end-to-end (callbacks fired for any events seen).
  // Returning true tells the caller NOT to run the non-streaming fallback.
  return true;
}
