"use client";

import { RefObject, useRef } from "react";
import DOMPurify from "dompurify";
import { cn } from "@/lib/cn";
import { renderMarkdown } from "@/lib/markdown";
import type { ChatMessage } from "./components";

/* ------------------------------------------------------------------ */
/*  Prompt chips — with icons, matching legacy renderPromptChips()     */
/* ------------------------------------------------------------------ */

const PROMPT_CHIPS: { icon: string; label: string; prompt: string }[] = [
  { icon: "edit_note", label: "Rewrite for Tone", prompt: "Rewrite the active section for a more formal, investment-committee-ready tone" },
  { icon: "bar_chart", label: "Add EBITDA Bridge", prompt: "Add an EBITDA bridge analysis" },
  { icon: "trending_up", label: "Revenue Growth", prompt: "Analyze the revenue growth trajectory and key drivers" },
  { icon: "warning", label: "Summarize Risks", prompt: "Summarize the key risks identified in this memo with severity ratings" },
  { icon: "groups", label: "Add Competitors", prompt: "Generate a competitive landscape analysis section for this memo" },
];

/* ------------------------------------------------------------------ */
/*  MemoChat                                                           */
/* ------------------------------------------------------------------ */

export interface MemoChatProps {
  messages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  sendingChat: boolean;
  onSend: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  chatEndRef: RefObject<HTMLDivElement | null>;
}

export function MemoChat({
  messages,
  chatInput,
  setChatInput,
  sendingChat,
  onSend,
  chatOpen,
  onToggleChat,
  chatEndRef,
}: MemoChatProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  if (!chatOpen) return null;

  return (
    <aside
      className="shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden max-[1439px]:absolute max-[1439px]:right-0 max-[1439px]:inset-y-0 max-[1439px]:z-30 max-[1439px]:max-w-[92%]"
      style={{ width: "400px", boxShadow: "-4px 0 24px -12px rgba(0,0,0,0.1)" }}
    >
      {/* Header — matches legacy AI panel header */}
      <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-white">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-sm">
            <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
          </div>
          <span className="font-bold text-slate-800 text-sm">AI Analyst</span>
        </div>
        <button
          onClick={onToggleChat}
          className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
          title="Collapse panel"
        >
          <span className="material-symbols-outlined text-[20px]">chevron_right</span>
        </button>
      </div>

      {/* Messages — bg-slate-50 matching legacy chat-messages */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-4 bg-slate-50">
        {messages.map((msg) =>
          msg.role === "assistant" ? (
            <div key={msg.id} className="flex gap-3">
              <div className="size-8 shrink-0 rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-sm mt-1">
                <span className="material-symbols-outlined text-[16px]">smart_toy</span>
              </div>
              <div className="flex flex-col gap-1 max-w-[85%]">
                <span className="text-[11px] font-semibold text-slate-500 ml-1">
                  AI Analyst &bull; {msg.timestamp}
                </span>
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-none p-3 shadow-sm text-sm text-slate-700 leading-relaxed">
                  <div
                    className="chat-markdown space-y-1"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(msg.content)) }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div key={msg.id} className="flex gap-3 flex-row-reverse">
              <div
                className="size-8 shrink-0 rounded-full border border-white flex items-center justify-center mt-1"
                style={{ backgroundColor: "#003366" }}
              >
                <span className="text-[11px] text-white font-bold">U</span>
              </div>
              <div className="flex flex-col gap-1 items-end max-w-[85%]">
                <span className="text-[11px] font-semibold text-slate-500 mr-1">
                  You &bull; {msg.timestamp}
                </span>
                <div className="bg-primary text-white rounded-2xl rounded-tr-none p-3 shadow-sm text-sm leading-relaxed">
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            </div>
          )
        )}
        {/* Typing indicator — matches legacy bouncing dots */}
        {sendingChat && (
          <div className="flex gap-3">
            <div className="size-8 shrink-0 rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-sm mt-1">
              <span className="material-symbols-outlined text-[16px]">smart_toy</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-slate-500 ml-1">
                AI Analyst &bull; typing...
              </span>
              <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-none p-3 shadow-sm">
                <div className="flex gap-1">
                  <span className="size-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="size-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="size-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input area — matches legacy structure */}
      <div className="p-4 bg-white border-t border-slate-200">
        {/* Prompt chips — with icons, horizontal scroll, gradient mask */}
        <div className="flex gap-2 overflow-x-auto pb-3 no-scrollbar mask-gradient">
          {PROMPT_CHIPS.map((chip, i) => (
            <button
              key={chip.label}
              onClick={() => setChatInput(chip.prompt)}
              className={cn(
                "shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium hover:bg-primary/20 hover:text-primary transition-colors border",
                i === 0
                  ? "bg-primary-light text-primary border-primary/20"
                  : "bg-slate-100 text-slate-600 border-slate-200"
              )}
            >
              <span className="material-symbols-outlined text-[14px]">{chip.icon}</span>
              {chip.label}
            </button>
          ))}
        </div>
        {/* Input box — matches legacy textarea style */}
        <div className="relative">
          <textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={3}
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 pl-4 pr-12 py-3 text-sm focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary outline-none transition-all placeholder:text-slate-400"
            placeholder="Ask AI to analyze, rewrite, or visualize data..."
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 text-slate-400 hover:text-primary rounded-lg transition-colors"
              title="Upload context"
            >
              <span className="material-symbols-outlined text-[20px]">attach_file</span>
            </button>
            <button
              onClick={onSend}
              disabled={!chatInput.trim() || sendingChat}
              className="p-1.5 text-white rounded-lg hover:opacity-90 transition-opacity shadow-sm disabled:opacity-40"
              style={{ backgroundColor: "#003366" }}
              title="Send message"
            >
              <span className="material-symbols-outlined text-[20px]">send</span>
            </button>
          </div>
        </div>
        <div className="mt-2 flex justify-between items-center px-1">
          <span className="text-[10px] text-slate-400">
            AI can make mistakes. Review generated financial data.
          </span>
        </div>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.xlsx,.xls,.doc,.docx,.csv"
          multiple
          onChange={() => {
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsed chat rail — vertical tab when chat is closed             */
/* ------------------------------------------------------------------ */

export function MemoChatCollapsed({ onOpen }: { onOpen: () => void }) {
  return (
    <aside className="w-12 bg-white border-l border-slate-200 flex flex-col shrink-0">
      <button
        onClick={onOpen}
        className="flex flex-col items-center justify-center gap-2 py-4 hover:bg-slate-50 transition-colors"
        title="Open AI Analyst"
      >
        <div className="size-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-sm">
          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
        </div>
        <span
          className="text-[10px] font-medium text-slate-500"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          AI Analyst
        </span>
      </button>
    </aside>
  );
}
