"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface Deal {
  id: string;
  name?: string;
  companyName?: string;
  industry?: string;
  stage?: string;
  createdAt: string;
  updatedAt?: string;
  Company?: { industry?: string };
}

const STAGE_BADGE: Record<string, string> = {
  DUE_DILIGENCE: "bg-blue-100 text-blue-700",
  IOI_SUBMITTED: "bg-purple-100 text-purple-700",
  SCREENING: "bg-amber-100 text-amber-700",
  INITIAL_REVIEW: "bg-amber-100 text-amber-700",
};

export default function DataRoomOverviewPage() {
  const router = useRouter();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<Deal[] | { deals: Deal[] }>("/deals?limit=100");
        const list = Array.isArray(data) ? data : data.deals || [];
        setDeals(list);
      } catch (err) {
        console.warn("[data-room] failed to load deals:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (showCreate) createInputRef.current?.focus();
  }, [showCreate]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const newDeal = await api.post<Deal>("/deals", {
        name,
        companyName: name,
        status: "ACTIVE",
        stage: "SCREENING",
      });
      if (newDeal?.id) {
        router.push(`/data-room/${newDeal.id}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create data room";
      setErrorMsg(
        msg.includes("403")
          ? "You need Associate role or higher to create data rooms. Contact your admin."
          : msg,
      );
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      setCreating(false);
      setShowCreate(false);
      setNewName("");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] w-full bg-slate-50">
        <div className="text-center">
          <div
            className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4"
            style={{ borderColor: "#003366" }}
          />
          <p className="text-slate-500">Loading Data Rooms...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-slate-50">
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-md"
            onClick={() => {
              setShowCreate(false);
              setNewName("");
            }}
          />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <div
                  className="flex items-center justify-center w-10 h-10 rounded-lg"
                  style={{ backgroundColor: "#E6EEF5" }}
                >
                  <span className="material-symbols-outlined text-primary">add_box</span>
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Create Data Room</h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setNewName("");
                }}
                className="p-1 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <span className="material-symbols-outlined text-slate-400">close</span>
              </button>
            </div>
            <div className="p-4">
              <label className="block text-sm font-medium text-slate-600 mb-2">
                Data Room Name
              </label>
              <input
                ref={createInputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreate();
                  } else if (e.key === "Escape") {
                    setShowCreate(false);
                    setNewName("");
                  }
                }}
                placeholder="e.g., Project Wagoner, Wagoner Industrial Add-On"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm text-slate-900 placeholder:text-slate-400"
              />
              <p className="mt-2 text-xs text-slate-400">
                A new data room will be created with default folders for due diligence.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 p-4 border-t border-slate-200 bg-slate-50/50">
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setNewName("");
                }}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="px-5 py-2 text-sm font-medium text-white rounded-lg shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                style={{ backgroundColor: "#003366" }}
              >
                {creating ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    Creating...
                  </>
                ) : (
                  "Create Data Room"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6 shrink-0">
        <div className="flex flex-col gap-0.5">
          <nav className="flex items-center gap-1 text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-slate-600 transition-colors">
              Dashboard
            </Link>
            <span className="material-symbols-outlined text-[12px]">chevron_right</span>
            <span className="text-slate-600 font-medium">Data Room</span>
          </nav>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-slate-900">All Data Rooms</h1>
            <span className="text-sm text-slate-400">{deals.length} active deals</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white shadow transition-colors"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Create Data Room
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6 custom-scrollbar">
        {deals.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <span className="material-symbols-outlined text-6xl text-slate-300 mb-4">
              folder_open
            </span>
            <h3 className="text-lg font-semibold text-slate-700 mb-2">No Data Rooms Yet</h3>
            <p className="text-slate-500 mb-6">
              Create your first data room to get started with due diligence
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-5 py-2.5 text-white rounded-lg transition-colors font-medium"
                style={{ backgroundColor: "#003366" }}
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                Create Data Room
              </button>
              <span className="text-slate-400">or</span>
              <Link
                href="/deals"
                className="px-4 py-2 text-slate-600 hover:text-slate-900 transition-colors font-medium"
              >
                Go to Deals
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {deals.map((deal) => {
              const stage = deal.stage || "SCREENING";
              const badge = STAGE_BADGE[stage] || "bg-slate-100 text-slate-600";
              const industry = deal.Company?.industry || deal.industry || "—";
              return (
                <Link
                  key={deal.id}
                  href={`/data-room/${deal.id}`}
                  className="bg-white rounded-lg border border-slate-200 p-4 hover:shadow-lg hover:border-slate-300 transition-all cursor-pointer group block"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-100 group-hover:bg-primary/10 transition-colors shrink-0">
                      <span className="material-symbols-outlined text-slate-600 group-hover:text-primary">
                        folder_open
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-slate-900 truncate">
                        {deal.name || deal.companyName || "Untitled Deal"}
                      </h3>
                      <p className="text-sm text-slate-500 truncate">{industry}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${badge}`}>
                      {stage.replace(/_/g, " ")}
                    </span>
                    <span className="text-slate-400 text-xs">
                      {new Date(deal.updatedAt || deal.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border max-w-sm bg-red-50 border-red-200">
          <span className="material-symbols-outlined text-xl text-red-600">error</span>
          <p className="text-sm text-slate-800 flex-1">{errorMsg}</p>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-slate-400 hover:text-slate-600"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}
    </div>
  );
}
