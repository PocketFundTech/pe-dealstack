"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

// Live tenant-isolation test. Admin-only — surfaces a button that calls
// /api/admin/security/run-isolation-test, which seeds a shadow org,
// runs 8 cross-org access checks, cleans up, and returns the results
// in <3s. Renders the output in a terminal-style panel.

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

interface IsolationResult {
  passed: number;
  total: number;
  checks: CheckResult[];
  durationMs: number;
}

const ADMIN_ROLES: Array<string> = ["ADMIN", "PARTNER", "PRINCIPAL"];

export function IsolationTest({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const { user } = useUser();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<IsolationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const role = (user.systemRole || "").toUpperCase();
  if (!ADMIN_ROLES.includes(role)) return null;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.post<IsolationResult>(
        "/admin/security/run-isolation-test",
        {},
      );
      setResult(data);
      if (data.passed === data.total) {
        onToast(`Isolation test passed (${data.passed}/${data.total})`, "success");
      } else {
        onToast(
          `Isolation test FAILED (${data.passed}/${data.total}) — investigate immediately`,
          "error",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Isolation test failed";
      setError(msg);
      onToast(msg, "error");
    } finally {
      setRunning(false);
    }
  };

  const fullPass = result && result.passed === result.total;

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-text-secondary">science</span>
          <div>
            <p className="text-sm font-semibold text-text-main">
              Live tenant-isolation test
            </p>
            <p className="text-xs text-text-muted">
              Admin-only. Seeds a shadow org, runs 8 cross-org checks, cleans up.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="px-4 py-2 text-white text-sm font-semibold rounded-lg shadow-card transition-colors disabled:opacity-50"
          style={{ backgroundColor: "#003366" }}
        >
          {running ? "Running..." : "Run Isolation Test"}
        </button>
      </div>

      {(result || error) && (
        <div
          className="p-4 rounded-lg border bg-[#0b1120] border-[#1e293b] font-mono text-xs leading-relaxed overflow-x-auto"
          aria-live="polite"
        >
          {error ? (
            <p className="text-red-400">→ ERROR: {error}</p>
          ) : result ? (
            <>
              {result.checks.map((c, i) => (
                <p
                  key={`${i}-${c.name}`}
                  className={c.passed ? "text-green-400" : "text-red-400"}
                >
                  → {c.name}
                  {"  "}
                  {c.passed ? "BLOCKED ✓" : "LEAKED ✗"}
                  {c.detail ? `  (${c.detail})` : ""}
                </p>
              ))}
              <p
                className={`mt-2 font-bold ${
                  fullPass ? "text-green-300" : "text-red-300"
                }`}
              >
                → {result.passed}/{result.total} isolation checks passed (
                {(result.durationMs / 1000).toFixed(1)}s)
              </p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
