"use client";

import { useEffect } from "react";

// Welcome view — ported from onboarding.html #view-welcome.
export function WelcomeView({
  onStart,
  onSample,
}: {
  onStart: () => void;
  onSample: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onStart();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onStart]);

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <div className="grid md:grid-cols-5 gap-10 items-center mt-6">
        <div className="md:col-span-3">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary-light text-primary text-[11px] font-semibold uppercase tracking-wider mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
            Purpose-built for PE
          </div>
          <h1 className="font-display text-[44px] leading-[1.05] font-bold tracking-tight text-text-main">
            Let&apos;s analyze your first deal.
            <span className="block text-text-muted">Three short steps.</span>
          </h1>
          <p className="mt-5 text-[15px] text-text-secondary max-w-lg leading-relaxed">
            Tell us who you are, drop in a CIM, and we&apos;ll show you what PE OS does. No prompts to write. No training required.
          </p>
          <div className="mt-8 flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={onStart}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ backgroundColor: "#003366" }}
            >
              Let&apos;s go
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
            <button
              type="button"
              onClick={onSample}
              className="inline-flex items-center rounded-lg border border-border-subtle bg-white px-4 py-2.5 text-text-secondary font-medium text-sm hover:border-border-focus hover:text-text-main transition-colors"
            >
              Use a sample deal
            </button>
            <span className="text-[12px] text-text-muted ml-2 hidden sm:inline">
              <kbd className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200">↵</kbd>
              {" "}continue
            </span>
          </div>

          <div className="mt-14 pt-8 border-t border-border-subtle grid grid-cols-3 gap-6 max-w-lg">
            {[
              { value: "< 3min", label: "To first insight" },
              { value: "No prompts", label: "Pre-loaded context" },
              { value: "Per-deal", label: "Access control" },
            ].map((s) => (
              <div key={s.label}>
                <div className="font-display text-[22px] font-bold text-primary">{s.value}</div>
                <div className="text-[10.5px] text-text-muted uppercase tracking-wider mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="md:col-span-2">
          <div className="bg-white border border-border-subtle rounded-xl shadow-card p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-muted font-medium mb-4">
              <span className="material-symbols-outlined text-[14px]">checklist</span>
              Your checklist
            </div>
            <ul className="space-y-3">
              <li className="flex items-center gap-3 text-[13px]">
                <ChecklistCircle text="1" />
                <span className="text-text-secondary">Define your investment focus</span>
              </li>
              <li className="flex items-center gap-3 text-[13px]">
                <ChecklistCircle text="2" />
                <span className="text-text-secondary">Upload your first deal</span>
              </li>
              <li className="flex items-center gap-3 text-[13px]">
                <ChecklistCircle text="3" />
                <span className="text-text-secondary">Invite your team</span>
                <span className="ml-auto text-[10.5px] text-text-muted uppercase">optional</span>
              </li>
            </ul>
            <div className="mt-4 pt-4 border-t border-border-subtle text-[12px] text-text-muted leading-relaxed">
              That&apos;s it. Pipeline, sources, and more live in the app — set them up when you need them.
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function ChecklistCircle({ text }: { text: string }) {
  return (
    <span className="inline-flex size-7 items-center justify-center rounded-full bg-gray-100 border border-border-subtle text-[13px] font-semibold text-gray-500">
      {text}
    </span>
  );
}
