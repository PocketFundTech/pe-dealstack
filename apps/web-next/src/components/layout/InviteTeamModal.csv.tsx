"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  BulkRole, MAX_BULK_ROWS, ParsedRow, RowResult, Stage, matchDeal, parseCsv, validateRows,
  type DealOption,
} from "./InviteTeamModal.csv.parse";
import { BulkInviteTable } from "./InviteTeamModal.csv.table";
import { CsvUploadStep } from "./InviteTeamModal.csv.upload";

type BulkResponse = {
  total: number;
  sent: number;
  results: {
    email: string;
    status: "sent" | "exists" | "pending" | "error";
    error?: string;
    deal?: "added" | "on_accept" | "not_saved";
  }[];
};

export function BulkCsvImportPanel({
  onBack,
  onClose,
}: {
  onBack: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>("upload");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [deals, setDeals] = useState<DealOption[]>([]);

  // Deals for the per-row "Deal" selector (and to match CSV deal names).
  useEffect(() => {
    let cancelled = false;
    api.get<DealOption[] | { deals: DealOption[] }>("/deals?limit=200")
      .then((data) => {
        if (cancelled) return;
        const list = (Array.isArray(data) ? data : data?.deals ?? [])
          .map((d) => ({ id: d.id, name: d.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setDeals(list);
        // A file read before the deal list arrived: match its deal names now.
        setRows((prev) => prev.some((r) => r.dealText && !r.dealId)
          ? prev.map((r) => (r.dealText && !r.dealId ? { ...r, dealId: matchDeal(r.dealText, list) } : r))
          : prev);
      })
      .catch((err) => console.warn("[bulk-invite] deals load failed:", err));
    return () => { cancelled = true; };
  }, []);

  const issues = useMemo(() => validateRows(rows), [rows]);
  const sendRows = useMemo(() => rows.filter((r) => r.checked && !issues.has(r.id)), [rows, issues]);
  const checkedCount = rows.filter((r) => r.checked).length;
  const blockingCount = rows.filter((r) => issues.has(r.id)).length;
  const tooMany = sendRows.length > MAX_BULK_ROWS;

  const updateRow = (id: string, patch: Partial<ParsedRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleAll = (checked: boolean) => setRows((prev) => prev.map((r) => ({ ...r, checked })));

  const handleFile = (file: File) => {
    setSubmitError(null);
    setTopError(null);
    if (
      !file.name.toLowerCase().endsWith(".csv") &&
      file.type !== "text/csv"
    ) {
      setTopError("Please upload a .csv file.");
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const { rows: parsed, topError: err } = parseCsv(text, deals);
      if (err) {
        setTopError(err);
        setRows([]);
        setStage("upload");
        return;
      }
      if (parsed.length === 0) {
        setTopError("No rows found in CSV.");
        setRows([]);
        setStage("upload");
        return;
      }
      setRows(parsed);
      setStage("preview");
    };
    reader.onerror = () => {
      setTopError("Could not read file.");
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    // Only included rows with no blocking issue are sent (QA #4).
    if (sendRows.length === 0 || tooMany || blockingCount > 0) return;
    setStage("submitting");
    setSubmitError(null);

    // The API takes one role per call. Group rows by role and call
    // POST /api/invitations/bulk once per role group; merge results
    // back onto the originating rows.
    const groups = new Map<BulkRole, ParsedRow[]>();
    for (const r of sendRows) {
      const list = groups.get(r.role) ?? [];
      list.push(r);
      groups.set(r.role, list);
    }

    const updated = new Map<string, RowResult>();
    let firstError: string | null = null;

    for (const [role, group] of groups.entries()) {
      try {
        const data = await api.post<BulkResponse>("/invitations/bulk", {
          role,
          invites: group.map((r) => ({ email: r.email.trim(), dealId: r.dealId })),
        });
        const byEmail = new Map((data.results ?? []).map((r) => [r.email.toLowerCase(), r]));
        for (const row of group) {
          const r = byEmail.get(row.email.trim().toLowerCase());
          if (!r) updated.set(row.id, { kind: "error", error: "No response for this email" });
          else if (r.status === "sent") updated.set(row.id, { kind: "sent", deal: r.deal === "added" ? undefined : r.deal });
          else if (r.status === "exists") updated.set(row.id, { kind: "exists", deal: r.deal === "added" ? "added" : undefined });
          else if (r.status === "pending") updated.set(row.id, { kind: "pending" });
          else updated.set(row.id, { kind: "error", error: r.error });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Request failed";
        firstError ??= msg;
        for (const row of group) updated.set(row.id, { kind: "error", error: msg });
      }
    }

    setRows((prev) =>
      prev.map((r) =>
        r.checked
          ? (updated.has(r.id) ? { ...r, result: updated.get(r.id) } : r)
          : { ...r, result: { kind: "skipped", reason: "Not selected" } },
      ),
    );
    setStage("done");
    if (firstError) setSubmitError(firstError);
  };

  const reset = () => {
    setStage("upload");
    setRows([]);
    setFileName(null);
    setTopError(null);
    setSubmitError(null);
  };

  const sentCount = rows.filter((r) => r.result?.kind === "sent").length;

  return (
    <div className="space-y-4">
      {/* Sub-header with breadcrumb back to row entry */}
      <div className="flex items-center justify-between border-b border-[#EBEBEB] pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={stage === "done" ? reset : onBack}
            className="flex items-center gap-1 text-sm text-[#003366] hover:text-blue-700 font-medium px-2 py-1 rounded-md hover:bg-[#E6EDF5] transition-colors"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            {stage === "done" ? "Import another file" : "Back to manual entry"}
          </button>
        </div>
        <div className="text-xs text-[#868E96]">
          {stage === "upload" && "Step 1 of 2 — Upload"}
          {stage === "preview" && "Step 2 of 2 — Review, edit & send"}
          {stage === "submitting" && "Sending..."}
          {stage === "done" && "Results"}
        </div>
      </div>

      {stage === "upload" && (
        <CsvUploadStep topError={topError} onFile={handleFile} />
      )}

      {(stage === "preview" || stage === "submitting" || stage === "done") && (
        <div className="space-y-4">
          {fileName && (
            <div className="flex items-center gap-2 text-sm text-[#868E96] flex-wrap">
              <span className="material-symbols-outlined text-base text-[#003366]">
                description
              </span>
              <span className="text-[#343A40] font-medium">{fileName}</span>
              <span>·</span>
              <span>
                {checkedCount} of {rows.length} selected
                {blockingCount > 0 && stage === "preview" && (
                  <span className="text-red-600"> · {blockingCount} need{blockingCount === 1 ? "s" : ""} fixing</span>
                )}
              </span>
            </div>
          )}

          {stage === "preview" && (
            <p className="text-xs text-[#868E96]">
              Edit any cell, untick rows you don&apos;t want to invite, and pick a deal to add each person to its team.
            </p>
          )}

          {tooMany && stage === "preview" && (
            <div className="rounded-lg p-3 text-sm border bg-red-50 border-red-200 text-red-700">
              Bulk invite is limited to {MAX_BULK_ROWS} people at a time. You have {sendRows.length} selected —
              untick some rows or split the file.
            </div>
          )}

          {submitError && (
            <div className="rounded-lg p-3 text-sm border bg-red-50 border-red-200 text-red-700">
              {submitError}
            </div>
          )}

          {stage === "done" && sentCount > 0 && (
            <div className="rounded-lg p-3 text-sm border bg-green-50 border-green-200 text-green-700">
              {sentCount} invitation{sentCount > 1 ? "s" : ""} sent successfully.
            </div>
          )}

          <BulkInviteTable
            rows={rows}
            issues={issues}
            deals={deals}
            stage={stage}
            onChange={updateRow}
            onToggleAll={toggleAll}
          />
        </div>
      )}

      {/* Action row */}
      <div className="flex justify-end gap-3 pt-2">
        {stage === "upload" && (
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-2.5 rounded-lg border border-[#EBEBEB] text-[#343A40] font-medium text-sm hover:bg-black/5 transition-colors"
          >
            Cancel
          </button>
        )}
        {stage === "preview" && (
          <>
            <button
              type="button"
              onClick={reset}
              className="px-5 py-2.5 rounded-lg border border-[#EBEBEB] text-[#343A40] font-medium text-sm hover:bg-black/5 transition-colors"
            >
              Choose another file
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={sendRows.length === 0 || tooMany || blockingCount > 0}
              title={blockingCount > 0 ? "Fix or untick the highlighted rows first" : undefined}
              className="px-5 py-2.5 rounded-lg text-white font-medium text-sm shadow-lg transition-all active:scale-95 flex items-center gap-2 disabled:opacity-60"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-lg">send</span>
              Send {sendRows.length} invitation
              {sendRows.length === 1 ? "" : "s"}
            </button>
          </>
        )}
        {stage === "submitting" && (
          <button
            type="button"
            disabled
            className="px-5 py-2.5 rounded-lg text-white font-medium text-sm shadow-lg flex items-center gap-2 opacity-60"
            style={{ backgroundColor: "#003366" }}
          >
            <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
            Sending...
          </button>
        )}
        {stage === "done" && (
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-lg text-white font-medium text-sm shadow-lg transition-all active:scale-95"
            style={{ backgroundColor: "#003366" }}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
