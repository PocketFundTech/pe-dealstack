"use client";

import {
  ROLE_LABEL, VALID_ROLES,
  type BulkRole, type DealOption, type ParsedRow, type Stage,
} from "./InviteTeamModal.csv.parse";
import { RowStatus } from "./InviteTeamModal.csv.row";

// Editable preview table for the bulk CSV invite (QA #4): include/skip
// checkbox per row + select-all, editable email, role and deal selectors,
// inline validation. Read-only once sending starts.

const cellInput =
  "w-full rounded-md border border-[#EBEBEB] bg-white px-2 py-1 text-sm text-[#343A40] focus:outline-none focus:ring-2 focus:ring-[#003366]/20 disabled:bg-transparent disabled:border-transparent";

export function BulkInviteTable({
  rows,
  issues,
  deals,
  stage,
  onChange,
  onToggleAll,
}: {
  rows: ParsedRow[];
  issues: Map<string, string>;
  deals: DealOption[];
  stage: Stage;
  onChange: (id: string, patch: Partial<ParsedRow>) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const editable = stage === "preview";
  const allChecked = rows.length > 0 && rows.every((r) => r.checked);
  const someChecked = rows.some((r) => r.checked);

  return (
    <div className="border border-[#EBEBEB] rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#F8F9FA] text-[#868E96]">
            <tr>
              <th className="px-3 py-2 text-left w-10">
                <input
                  type="checkbox"
                  aria-label="Include all rows"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                  disabled={!editable}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  className="h-4 w-4 accent-[#003366]"
                />
              </th>
              <th className="px-3 py-2 text-left font-medium w-10">#</th>
              <th className="px-3 py-2 text-left font-medium min-w-[220px]">Email</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-left font-medium min-w-[180px]">Deal</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const issue = issues.get(r.id);
              const dealName = r.dealId ? deals.find((d) => d.id === r.dealId)?.name : undefined;
              return (
                <tr key={r.id} className={`border-t border-[#EBEBEB] ${r.checked ? "" : "opacity-50"}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Include row ${r.rowNumber}`}
                      checked={r.checked}
                      disabled={!editable}
                      onChange={(e) => onChange(r.id, { checked: e.target.checked })}
                      className="h-4 w-4 accent-[#003366]"
                    />
                  </td>
                  <td className="px-3 py-2 text-[#868E96]">{r.rowNumber}</td>
                  <td className="px-3 py-2">
                    <input
                      type="email"
                      aria-label={`Email, row ${r.rowNumber}`}
                      value={r.email}
                      disabled={!editable}
                      onChange={(e) => onChange(r.id, { email: e.target.value })}
                      placeholder="name@firm.com"
                      className={`${cellInput} ${issue && /email/i.test(issue) ? "border-red-300" : ""}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Role, row ${r.rowNumber}`}
                      value={r.role}
                      disabled={!editable}
                      onChange={(e) => onChange(r.id, { role: e.target.value as BulkRole, note: undefined })}
                      className={cellInput}
                    >
                      {VALID_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    {editable ? (
                      <select
                        aria-label={`Deal, row ${r.rowNumber}`}
                        value={r.dealId ?? ""}
                        // Picking any value (incl. "No deal") resolves an unmatched CSV name.
                        onChange={(e) => onChange(r.id, { dealId: e.target.value || null, dealText: "" })}
                        className={`${cellInput} ${issue && /^Deal/.test(issue) ? "border-red-300" : ""}`}
                      >
                        <option value="">No deal</option>
                        {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    ) : (
                      <span className="text-[#868E96]">{dealName ?? <span className="italic">—</span>}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <RowStatus row={r} stage={stage} issue={issue} dealName={dealName} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
