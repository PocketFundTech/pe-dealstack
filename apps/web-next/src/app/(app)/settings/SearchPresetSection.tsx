"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";
import { invalidateApiCache } from "@/lib/useApiQuery";
import { USERS_ME_KEY } from "./settings-api-keys";
import Link from "next/link";
interface PresetResponse {
  searchProfile: { answers: Record<string, unknown>; updatedAt: string } | null;
  brief: string;
  warnings?: string[];
}
export function SearchPresetSection({ onApplied }: { onApplied: () => void }) {
  const { user } = useUser();
  const admin = user?.systemRole?.toUpperCase() === "ADMIN";
  const [saved, setSaved] = useState<PresetResponse | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { let cancelled=false; api.get<PresetResponse>("/firm-context/search-preset").then(value => { if(!cancelled)setSaved(value); }).catch(() => { if(!cancelled)setError("Could not load your search profile. Refresh to try again."); }).finally(() => { if(!cancelled)setLoading(false); }); return () => { cancelled=true; }; }, []);
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file=event.target.files?.[0]; event.target.value="";
    if(!file)return;
    setPending(null); setError("");
    try {
      if(file.size>100_000)throw new Error("Choose a search export smaller than 100 KB.");
      const document=JSON.parse(await file.text());
      const answers=document?.answers ?? document;
      if(!answers || typeof answers!=="object" || Array.isArray(answers) || typeof answers.firmName!=="string" || typeof answers.thesis!=="string")throw new Error("Choose the JSON search profile exported from search setup.");
      if(document.setupStatus==='skipped')throw new Error("Finish the saved search setup before importing its profile.");
      setPending(answers); setFilename(file.name);
    } catch(err) { setError(err instanceof Error?err.message:"Could not read this search profile."); }
  }
  async function apply() {
    setSaving(true);setError("");
    try {
      const result=await api.post<PresetResponse>("/firm-context/search-preset",{answers:pending});
      setSaved(result);setPending(null);invalidateApiCache(USERS_ME_KEY);onApplied();
    } catch(err) { setError(err instanceof Error?err.message:"Could not apply search presets."); }
    finally { setSaving(false); }
  }
  return <section id="section-search-profile" className="rounded-xl border border-border-subtle bg-surface-card p-6 scroll-mt-6">
    <h2 className="text-base font-bold text-text-main">Search Profile</h2>
    <p className="mt-2 text-sm text-text-secondary">Your search gives the AI assistant context about your firm, target businesses, preferences and deal flow. You can add it here whenever you’re ready.</p>
    {loading && <p className="mt-4 text-sm text-text-secondary">Loading search profile…</p>}
    {saved?.searchProfile && <details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-primary">{String(saved.searchProfile.answers.firmName)} · View saved search profile</summary><pre className="mt-3 whitespace-pre-wrap break-words text-sm font-sans leading-7 text-text-secondary">{saved.brief}</pre></details>}
    {admin && <div className="mt-5">
      <Link href="/onboarding?search=1" className="mb-4 inline-flex rounded-lg px-4 py-2 text-sm text-white" style={{backgroundColor:'#003366'}}>{saved?.searchProfile?'Edit search profile':'Complete search setup'}</Link>
      <p className="text-xs text-text-secondary">Import the JSON export from search setup. This fills missing Firm Profile fields and seeds Firm Context and Investment Criteria if they’re empty. Existing saved settings are preserved. The complete search profile stays available to the AI assistant.</p>
      <input ref={input} type="file" accept=".json,application/json" onChange={pick} className="sr-only" aria-label="Search profile JSON file" disabled={saving} />
      <button type="button" onClick={()=>input.current?.click()} disabled={saving} className="mt-4 rounded-lg border border-border-subtle px-4 py-2 text-sm text-primary disabled:opacity-50">Import search profile</button>
      {pending && <div className="mt-4 rounded-lg border border-border-subtle p-4">
        <p className="text-xs text-text-secondary break-all">{filename}</p>
        <p className="mt-2 text-sm font-medium">{String(pending.firmName)}</p>
        <p className="mt-2 text-sm text-text-secondary whitespace-pre-wrap">{String(pending.thesis)}</p>
        <p className="mt-2 text-xs text-text-secondary">Currency: {String(pending.currency || "USD")}. Numeric Investment Criteria use USD; other currencies stay in the search profile until you enter converted values.</p>
        <div className="mt-4 flex gap-3"><button type="button" onClick={apply} disabled={saving} style={{backgroundColor:"#003366"}} className="rounded-lg px-4 py-2 text-sm text-white disabled:opacity-50">{saving?"Applying…":"Apply search presets"}</button><button type="button" onClick={()=>setPending(null)} disabled={saving} className="px-3 py-2 text-sm">Cancel</button></div>
      </div>}
    </div>}
    {!admin && <p className="mt-4 text-xs text-text-secondary">A workspace admin can import firm-wide search presets.</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    {saved?.warnings && <div role="status" className="mt-4 text-sm text-text-secondary"><p className="font-medium text-primary">Search presets saved.</p>{saved.warnings.map(message=><p className="mt-2" key={message}>{message}</p>)}</div>}
  </section>;
}
