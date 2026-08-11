"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// Mirrors the in-app trust block from the legacy apps/web/js/settingsSecurity.js:
// shows the customer their own org info (proof of isolation), the
// encryption checklist, the isolation badge, AI handling note, and
// action buttons (PDF, sub-processors, DPA).

interface OrgMe {
  id: string;
  name: string;
  slug?: string | null;
  requireMFA?: boolean;
}

const ENCRYPTION_CHECKS = [
  { label: "AES-256 at rest", icon: "lock" },
  { label: "TLS 1.2+ in transit", icon: "https" },
  { label: "Bearer JWT session tokens", icon: "vpn_key" },
  { label: "Helmet middleware + CORS allow-list", icon: "verified_user" },
];

export function TrustPosture() {
  const [org, setOrg] = useState<OrgMe | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<OrgMe>("/organizations/me");
        if (!cancelled) setOrg(data);
      } catch (err) {
        console.warn("[settings/security/trust] /organizations/me failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="border-t border-border-subtle pt-4 space-y-4">
      {/* Org info — proof of isolation */}
      <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle">
        <div className="flex items-center gap-3 mb-3">
          <span className="material-symbols-outlined text-text-secondary">domain</span>
          <div>
            <p className="text-sm font-semibold text-text-main">Your organization</p>
            <p className="text-xs text-text-muted">
              All data is scoped to this org. No other firm can access it.
            </p>
          </div>
        </div>
        {loading ? (
          <p className="text-xs text-text-muted">Loading...</p>
        ) : org ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-text-muted uppercase tracking-wider font-semibold">Name</dt>
              <dd className="text-text-main font-medium">{org.name}</dd>
            </div>
            <div>
              <dt className="text-text-muted uppercase tracking-wider font-semibold">
                Organization ID
              </dt>
              <dd className="text-text-main font-mono break-all">{org.id}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-text-muted">Could not load org info.</p>
        )}
      </div>

      {/* Encryption checklist */}
      <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle">
        <div className="flex items-center gap-3 mb-3">
          <span className="material-symbols-outlined text-text-secondary">enhanced_encryption</span>
          <div>
            <p className="text-sm font-semibold text-text-main">Encryption &amp; transport</p>
            <p className="text-xs text-text-muted">
              Always-on protections applied to every request.
            </p>
          </div>
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ENCRYPTION_CHECKS.map((c) => (
            <li
              key={c.label}
              className="flex items-center gap-2 text-xs text-text-main"
            >
              <span
                className="material-symbols-outlined text-green-600 text-[16px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
              {c.label}
            </li>
          ))}
        </ul>
      </div>

      {/* Tenant isolation badge */}
      <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle flex items-start gap-3">
        <span className="material-symbols-outlined text-text-secondary mt-0.5">shield_lock</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-text-main">Tenant isolation enforced</p>
          <p className="text-xs text-text-muted mt-1">
            <span className="font-semibold text-text-main">34 automated tests</span> and{" "}
            <span className="font-semibold text-text-main">268 explicit org-scope checks</span>{" "}
            across 45 API route files (audited 2026-04-30). Cross-org access attempts return
            HTTP 404, not 403, to prevent resource enumeration.
          </p>
        </div>
      </div>

      {/* AI handling */}
      <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle flex items-start gap-3">
        <span className="material-symbols-outlined text-text-secondary mt-0.5">smart_toy</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-text-main">AI &amp; LLM data handling</p>
          <p className="text-xs text-text-muted mt-1">
            We use OpenAI, Anthropic, Google, and Azure on their <strong>API tiers</strong> —
            contractually no model training on your data. Your CIMs, LOIs, and memos never feed
            any model.
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <a
          href="/assets/pocket-fund-security-overview.pdf"
          download
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-border-subtle text-text-main text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
        >
          <span className="material-symbols-outlined text-[18px]">download</span>
          Security Overview PDF
        </a>
        <a
          href="/security#sub-processors"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-border-subtle text-text-main text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
        >
          <span className="material-symbols-outlined text-[18px]">list</span>
          Sub-processor list
        </a>
        <a
          href="mailto:security@pocket-fund.com?subject=DPA%20Request"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-border-subtle text-text-main text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
        >
          <span className="material-symbols-outlined text-[18px]">description</span>
          Request DPA
        </a>
      </div>
    </div>
  );
}
