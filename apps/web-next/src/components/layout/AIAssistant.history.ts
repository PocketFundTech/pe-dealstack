// Persisted AI-assistant conversations (localStorage). Extracted from
// AIAssistant.tsx to keep it under the 500-line cap.
//
// One bucket per conversation: per context type, and per DEAL for deal
// context — every deal used to share one "deal" bucket, so a chat about one
// deal reappeared on another (and "clear" seemed not to work; 5 Oct testing,
// item 19).

import { STORAGE_KEYS } from "@/lib/storageKeys";
import type { ChatContext, ChatMessage } from "./ai-assistant-shared";

const MAX_PERSISTED_MESSAGES = 40;

type HistoryStore = Record<string, ChatMessage[]>;

export function historyBucket(ctx: ChatContext): string {
  return ctx.type === "deal" && ctx.dealId ? `deal:${ctx.dealId}` : ctx.type;
}

function readStore(): HistoryStore {
  const raw = window.localStorage.getItem(STORAGE_KEYS.aiAssistantHistory);
  return raw ? (JSON.parse(raw) as HistoryStore) : {};
}

export function loadHistory(ctx: ChatContext): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const bucket = readStore()?.[historyBucket(ctx)];
    if (!Array.isArray(bucket)) return [];
    return bucket.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch (err) {
    console.warn("[layout/AIAssistant] failed to load chat history:", err);
    return [];
  }
}

export function saveHistory(ctx: ChatContext, messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    store[historyBucket(ctx)] = messages.slice(-MAX_PERSISTED_MESSAGES);
    window.localStorage.setItem(STORAGE_KEYS.aiAssistantHistory, JSON.stringify(store));
  } catch (err) {
    // Quota or parse error — history is best-effort.
    console.warn("[layout/AIAssistant] failed to save chat history:", err);
  }
}

export function clearHistory(ctx: ChatContext): void {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    delete store[historyBucket(ctx)];
    window.localStorage.setItem(STORAGE_KEYS.aiAssistantHistory, JSON.stringify(store));
  } catch (err) {
    console.warn("[layout/AIAssistant] failed to clear chat history:", err);
  }
}
