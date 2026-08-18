"use client";

import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/formatters";
import { TaskModalShell } from "./task-modal-shell";

// CIM upload task modal — drag/drop file + 2 demo deal options.
// Ported from OnboardingTasks._renderers.cim. File upload API wiring is
// deferred: for now, picking a file marks the step as completable; the
// actual upload is handled by the normal deal-intake flow the user hits
// next. Demo deal creation runs on "Mark as done" via the parent page.
export function CimTaskModal({
  file,
  onFile,
  sampleId,
  onSample,
  onClose,
  onComplete,
  busy = false,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  sampleId: string | null;
  onSample: (id: string | null) => void;
  onClose: () => void;
  onComplete: () => void;
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const canComplete = file !== null || sampleId !== null;

  // Legacy: when a sample deal is selected, the dropzone transforms to show
  // a green check + sample name (onboarding-tasks.js cim hydrator).
  const SAMPLE_NAMES: Record<string, string> = {
    wagoner: "Wagoner Industrial Supply — Industrial Distribution CIM",
  };
  const sampleSelected = sampleId !== null && !file;

  const handleSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      onFile(f);
      onSample(null);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      onFile(f);
      onSample(null);
    }
  };

  return (
    <TaskModalShell
      icon="upload_file"
      title="Upload your first deal"
      onClose={onClose}
      onComplete={onComplete}
      canComplete={canComplete}
      busy={busy}
      busyLabel={sampleId ? "Creating demo deal..." : "Uploading..."}
    >
      <p className="text-[13.5px] text-text-secondary mb-4">
        Drop a CIM, teaser, or balance sheet. We&apos;ll parse every table and chart.
      </p>

      <div
        onClick={() => !sampleSelected && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "border-2 rounded-xl p-6 cursor-pointer transition-colors",
          sampleSelected
            ? "border-secondary/30 bg-secondary-light/10"
            : "border-dashed",
          !sampleSelected && (dragOver ? "border-primary bg-primary-light/30" : "border-border-subtle hover:border-primary"),
          sampleSelected ? "text-left" : "text-center",
        )}
      >
        {sampleSelected ? (
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center flex-shrink-0">
              <span
                className="material-symbols-outlined text-secondary text-[20px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
            </div>
            <div>
              <div className="text-[13.5px] font-semibold text-text-main">
                {SAMPLE_NAMES[sampleId!] ?? "Sample deal selected"}
              </div>
              <div className="text-[12px] text-text-muted">Demo data will be loaded into your workspace</div>
            </div>
          </div>
        ) : (
          <>
            <div
              className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center mb-3"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-white text-[24px]">upload</span>
            </div>
            {file ? (
              <>
                <div className="text-[14px] font-semibold text-text-main">{file.name}</div>
                <div className="text-[12px] text-text-muted mt-1">{formatFileSize(file.size)}</div>
              </>
            ) : (
              <>
                <div className="text-[14px] font-semibold text-text-main">Drop your CIM here</div>
                <div className="text-[12px] text-text-muted mt-1">PDF · XLSX · DOCX · up to 50MB</div>
              </>
            )}
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.xlsx,.docx"
          onChange={handleSelect}
          className="hidden"
        />
      </div>

      <div className="text-[12px] text-text-muted text-center my-3">— or try a sample —</div>

      <div className="space-y-2">
        <SampleOption
          id="wagoner"
          title="Wagoner Industrial Supply"
          subtitle="Industrial distribution · $1.9M EBITDA · founder-led, 3rd gen"
          demoBadge
          selected={sampleId === "wagoner"}
          onSelect={() => {
            onSample("wagoner");
            onFile(null);
          }}
        />
      </div>
    </TaskModalShell>
  );
}

function SampleOption({
  id,
  title,
  subtitle,
  demoBadge,
  selected,
  onSelect,
}: {
  id: string;
  title: string;
  subtitle: string;
  demoBadge?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-sample={id}
      className={cn(
        "w-full flex items-center gap-3 rounded-lg border p-3.5 text-left transition-colors",
        selected ? "border-primary bg-[#F5F9FD] shadow-[inset_0_0_0_1px_#003366]" : "border-border-subtle bg-white hover:border-border-focus hover:bg-[#FAFBFC]",
      )}
    >
      <span className="material-symbols-outlined text-text-muted text-[18px]">description</span>
      <div className="flex-1">
        <div className="text-[13.5px] font-semibold text-text-main">{title}</div>
        <div className="text-[12px] text-text-muted">{subtitle}</div>
      </div>
      {demoBadge && (
        <span className="text-[11px] text-secondary font-semibold uppercase tracking-wider">Demo</span>
      )}
    </button>
  );
}
