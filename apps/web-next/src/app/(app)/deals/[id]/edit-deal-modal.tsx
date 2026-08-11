"use client";

import { useEffect, useState } from "react";
import { STAGE_LABELS, STAGES } from "@/lib/constants";
import { CURRENCY_SYMBOLS, formatCurrency, getCurrencySymbol } from "@/lib/formatters";
import { api } from "@/lib/api";
import type { DealDetail } from "./deal-detail-shared";

// Ported from deal-edit.js (showEditDealModal + saveDealChangesFromModal).
// Stored deal values are in millions of the original currency; the unit selector
// lets the user enter values in $/K/M/B (or for INR, ₹/L/Cr) and we convert
// back to millions on save. The rest of the codebase (deal-layout, kanban
// cards, dashboard, CSV export, ...) all treat `deal.revenue|ebitda|dealSize`
// as millions and feed them straight into `formatCurrency`, so we must keep
// storing at MILLIONS — only the *displayed* input value changes when the
// user toggles the unit dropdown.

type Unit = "$" | "K" | "M" | "B";

function millionsToNatural(valueInMillions: number | null | undefined): { value: string; unit: Unit } {
  if (valueInMillions == null) return { value: "", unit: "$" };
  const abs = Math.abs(valueInMillions);
  if (abs >= 1000) return { value: String(parseFloat((valueInMillions / 1000).toPrecision(10))), unit: "B" };
  if (abs >= 1) return { value: String(parseFloat(valueInMillions.toPrecision(10))), unit: "M" };
  if (abs >= 0.001) return { value: String(parseFloat((valueInMillions * 1000).toPrecision(10))), unit: "K" };
  return { value: String(parseFloat((valueInMillions * 1_000_000).toPrecision(10))), unit: "$" };
}

function naturalToMillions(value: string, unit: Unit): number | null {
  if (value === "" || value == null) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  switch (unit) {
    case "B": return num * 1000;
    case "M": return num;
    case "K": return num / 1000;
    case "$": return num / 1_000_000;
  }
}

// Re-render the input string so it represents the same millions amount
// expressed in `unit`. Used when the user toggles the unit dropdown — we
// preserve the underlying value rather than reinterpreting whatever number
// is currently in the input.
function millionsToValueForUnit(valueInMillions: number | null, unit: Unit): string {
  if (valueInMillions == null) return "";
  switch (unit) {
    case "B": return String(parseFloat((valueInMillions / 1000).toPrecision(10)));
    case "M": return String(parseFloat(valueInMillions.toPrecision(10)));
    case "K": return String(parseFloat((valueInMillions * 1000).toPrecision(10)));
    case "$": return String(parseFloat((valueInMillions * 1_000_000).toPrecision(10)));
  }
}

function unitLabels(currency: string): Record<Unit, string> {
  const sym = getCurrencySymbol(currency).trim();
  const isINR = currency === "INR";
  return {
    "$": sym,
    K: sym + "K",
    M: isINR ? sym + "L" : sym + "M",
    B: isINR ? sym + "Cr" : sym + "B",
  };
}

function CurrencyInput({
  id, label, valueInMillions, currency, onChange, placeholder,
}: {
  id: string;
  label: string;
  valueInMillions: number | null | undefined;
  currency: string;
  onChange: (millions: number | null) => void;
  placeholder?: string;
}) {
  const initial = millionsToNatural(valueInMillions);
  const [value, setValue] = useState(initial.value);
  const [unit, setUnit] = useState<Unit>(initial.unit);
  const labels = unitLabels(currency);

  // Single source of truth: the millions number derived from the currently
  // entered (value, unit) pair. Pushed to the parent on any change so save
  // gets the latest figure, and used for the "Currently: …" preview so it
  // reflects in-flight edits rather than the original prop.
  const liveMillions = naturalToMillions(value, unit);
  useEffect(() => { onChange(liveMillions); }, [liveMillions]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Toggling the unit dropdown should NOT reinterpret the typed number as a
  // different magnitude — it should re-express the same underlying millions
  // value in the new unit. e.g. value=5, unit=M → switch to K → value=5000,
  // unit=K. Both represent $5M. If the input is empty we just swap the unit.
  const handleUnitChange = (next: Unit) => {
    if (next === unit) return;
    if (liveMillions == null) {
      setUnit(next);
      return;
    }
    setValue(millionsToValueForUnit(liveMillions, next));
    setUnit(next);
  };

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text-main mb-1.5">{label}</label>
      <div className="flex gap-1.5">
        <select
          value={unit}
          onChange={(e) => handleUnitChange(e.target.value as Unit)}
          className="px-2 py-2 border border-border-subtle rounded-lg text-sm bg-gray-50 font-medium text-text-secondary shrink-0 focus:ring-2 focus:ring-primary/20 focus:border-primary"
          style={{ width: 70 }}
        >
          <option value="$">{labels["$"]}</option>
          <option value="K">{labels.K}</option>
          <option value="M">{labels.M}</option>
          <option value="B">{labels.B}</option>
        </select>
        <input
          id={id}
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
        />
      </div>
      <p className="text-[10px] text-text-muted mt-1">
        {liveMillions != null ? `Currently: ${formatCurrency(liveMillions, currency)}` : "No value set"}
      </p>
    </div>
  );
}

export function EditDealModal({
  deal,
  onClose,
  onSaved,
}: {
  deal: DealDetail;
  onClose: () => void;
  onSaved: (updated: DealDetail) => void;
}) {
  const [name, setName] = useState(deal.name || "");
  const [stage, setStage] = useState(deal.stage);
  const [industry, setIndustry] = useState(deal.industry || "");
  const [currency, setCurrency] = useState(deal.currency || "USD");
  const [revenue, setRevenue] = useState<number | null>(deal.revenue ?? null);
  const [ebitda, setEbitda] = useState<number | null>(deal.ebitda ?? null);
  const [dealSize, setDealSize] = useState<number | null>(deal.dealSize ?? null);
  const [irr, setIrr] = useState(deal.irrProjected != null ? String(deal.irrProjected) : "");
  const [mom, setMom] = useState(deal.mom != null ? String(deal.mom) : "");
  const [description, setDescription] = useState(deal.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const irrNum = irr.trim() === "" ? null : parseFloat(irr);
      const momNum = mom.trim() === "" ? null : parseFloat(mom);
      const updated = await api.patch<DealDetail>(`/deals/${deal.id}`, {
        name: name.trim() || deal.name,
        stage,
        industry: industry.trim() || null,
        currency,
        revenue,
        ebitda,
        dealSize,
        irrProjected: irrNum != null && !isNaN(irrNum) ? irrNum : null,
        mom: momNum != null && !isNaN(momNum) ? momNum : null,
        description: description.trim() || null,
      });
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full my-8">
        <div className="p-5 border-b border-border-subtle flex items-center justify-between">
          <h3 className="font-bold text-text-main text-base flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">edit_document</span>
            Edit Deal Details
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-main transition-colors">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="p-5 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-text-main mb-1.5">Deal Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Stage</label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Industry</label>
              <input
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-text-main mb-1.5">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                {Object.entries(CURRENCY_SYMBOLS).map(([code, sym]) => (
                  <option key={code} value={code}>{sym.trim()} — {code}</option>
                ))}
              </select>
            </div>
            <CurrencyInput id="edit-revenue" label="Revenue" valueInMillions={deal.revenue} currency={currency} onChange={setRevenue} placeholder="e.g., 1800" />
            <CurrencyInput id="edit-ebitda" label="EBITDA" valueInMillions={deal.ebitda} currency={currency} onChange={setEbitda} placeholder="e.g., 500" />
            <CurrencyInput id="edit-dealSize" label="Deal Size" valueInMillions={deal.dealSize} currency={currency} onChange={setDealSize} placeholder="e.g., 6000" />
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Projected IRR (%)</label>
              <input
                type="number"
                step="0.1"
                value={irr}
                onChange={(e) => setIrr(e.target.value)}
                placeholder="e.g., 24"
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-text-main mb-1.5">MoM Multiple</label>
              <input
                type="number"
                step="0.1"
                value={mom}
                onChange={(e) => setMom(e.target.value)}
                placeholder="e.g., 3.5"
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-text-main mb-1.5">Description</label>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of the deal..."
                className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
          </div>
          {error && (
            <div className="flex items-center gap-2 mt-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <span className="material-symbols-outlined text-red-500 text-sm">error</span>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </div>
        <div className="p-5 border-t border-border-subtle flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-white rounded-lg font-medium text-sm disabled:opacity-60 transition-colors"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {saving ? "Saving..." : "Save Changes"}
          </button>
          <button
            onClick={onClose}
            className="px-6 py-2.5 border border-border-subtle rounded-lg font-medium text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
