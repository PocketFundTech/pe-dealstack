"use client";

import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";

// Contract: POST /contacts/:id/chat  { message, history } -> { response, model }
interface ChatResponse {
  response: string;
  model: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTED_PROMPTS = [
  "How do I know them?",
  "What should I follow up on?",
  "Summarize our relationship",
];

// How many prior turns to send back as context.
const HISTORY_LIMIT = 8;

export function ContactAskAI({ contactId, contactName }: { contactId: string; contactName: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;

    const history = messages.slice(-HISTORY_LIMIT);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: message }];
    setMessages(nextMessages);
    setInput("");
    setThinking(true);
    try {
      const data = await api.post<ChatResponse>(`/contacts/${contactId}/chat`, { message, history });
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to get an answer", "error");
      // Roll back the optimistic user message so they can retry cleanly, and
      // restore the input so they don't have to retype it.
      setMessages((prev) => prev.slice(0, -1));
      setInput(message);
    } finally {
      setThinking(false);
    }
  }

  return (
    <div className="mb-6">
      <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3 flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[16px] text-primary">smart_toy</span>Ask AI about {contactName}
      </h4>
      <div className="rounded-lg border border-border-subtle bg-gray-50 overflow-hidden">
        <div ref={scrollRef} className="max-h-64 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2.5">
          {messages.length === 0 && !thinking && (
            <div className="flex flex-col gap-2 py-1">
              <p className="text-xs text-text-muted">Ask anything about this contact:</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    className="px-2.5 py-1 rounded-full bg-white text-text-secondary text-xs font-medium border border-border-subtle hover:border-primary/40 hover:text-primary transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                  m.role === "user"
                    ? "bg-primary text-white"
                    : "bg-white border border-border-subtle text-text-secondary",
                )}
                style={m.role === "user" ? { backgroundColor: "#003366" } : undefined}
              >
                {m.content}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 rounded-lg px-3 py-2 bg-white border border-border-subtle text-sm text-text-muted">
                <span className="material-symbols-outlined text-[16px] animate-spin text-primary">sync</span>
                Thinking...
              </div>
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="flex items-center gap-2 border-t border-border-subtle bg-white p-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={thinking}
            placeholder="Ask a question..."
            className="flex-1 rounded-md border border-border-subtle bg-white px-2.5 py-1.5 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={thinking || !input.trim()}
            className="shrink-0 p-2 rounded-md text-white hover:opacity-90 transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
            title="Send"
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
          </button>
        </form>
      </div>
    </div>
  );
}
