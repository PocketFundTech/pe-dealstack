"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DealCriteria {
  sectorsInclude: string[];
  sectorsExclude: string[];
  dealSizeMin: number | null;
  dealSizeMax: number | null;
  revenueMin: number | null;
  revenueMax: number | null;
  ebitdaMin: number | null;
  hardExclusions: string[];
  thesis: string;
}

const EMPTY: DealCriteria = {
  sectorsInclude: [], sectorsExclude: [], dealSizeMin: null, dealSizeMax: null,
  revenueMin: null, revenueMax: null, ebitdaMin: null, hardExclusions: [], thesis: "",
};

const csv = (arr: string[]) => arr.join(", ");
const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function CriteriaSection() {
  const [criteria, setCriteria] = useState<DealCriteria>(EMPTY);
  const [seeded, setSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<{ criteria: DealCriteria | null; seededFromFirmProfile: boolean }>(
          "/organizations/criteria",
        );
        if (data.criteria) setCriteria(data.criteria);
        setSeeded(data.seededFromFirmProfile);
      } catch (err) {
        console.warn("criteria load failed", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch("/organizations/criteria", criteria);
      setSaved(true);
      setSeeded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save criteria");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-sm text-text-muted">Loading criteria...</p>;

  return (
    <div id="section-criteria" className="bg-surface-card rounded-lg border border-border-subtle p-6">
      <h3 className="text-base font-bold text-text-main mb-1">Investment Criteria</h3>
      <p className="text-xs text-text-muted mb-4">
        The deal scorecard grades every deal against these criteria.
        {seeded && " Pre-filled from your firm profile — review and save."}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="text-xs font-semibold text-text-secondary">
          Sectors (include)
          <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.sectorsInclude)}
            onChange={(e) => setCriteria({ ...criteria, sectorsInclude: parseCsv(e.target.value) })} placeholder="SaaS, Healthcare" />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Sectors (exclude)
          <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.sectorsExclude)}
            onChange={(e) => setCriteria({ ...criteria, sectorsExclude: parseCsv(e.target.value) })} placeholder="Retail" />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Deal size min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.dealSizeMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, dealSizeMin: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Deal size max ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.dealSizeMax ?? ""}
            onChange={(e) => setCriteria({ ...criteria, dealSizeMax: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          Revenue min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.revenueMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, revenueMin: num(e.target.value) })} />
        </label>
        <label className="text-xs font-semibold text-text-secondary">
          EBITDA min ($M)
          <input type="number" className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.ebitdaMin ?? ""}
            onChange={(e) => setCriteria({ ...criteria, ebitdaMin: num(e.target.value) })} />
        </label>
      </div>

      <label className="block text-xs font-semibold text-text-secondary mt-4">
        Hard exclusions
        <input className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={csv(criteria.hardExclusions)}
          onChange={(e) => setCriteria({ ...criteria, hardExclusions: parseCsv(e.target.value) })} placeholder="startups, turnarounds" />
      </label>

      <label className="block text-xs font-semibold text-text-secondary mt-4">
        Investment thesis
        <textarea rows={3} className="mt-1 w-full rounded-md border border-border-subtle px-3 py-2 text-sm" value={criteria.thesis}
          onChange={(e) => setCriteria({ ...criteria, thesis: e.target.value })} placeholder="Recurring-revenue businesses with low CapEx..." />
      </label>

      <div className="flex items-center gap-3 mt-4">
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-md text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: "#003366" }}>
          {saving ? "Saving..." : "Save criteria"}
        </button>
        {saved && <span className="text-xs text-green-600 font-semibold">Saved</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
