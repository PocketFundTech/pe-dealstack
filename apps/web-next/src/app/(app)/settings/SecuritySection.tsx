"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { TrustPosture } from "./SecuritySection.trust";
import { ActiveSessions } from "./SecuritySection.sessions";
import { IsolationTest } from "./SecuritySection.isolationTest";
import { StaffAccessLog } from "./SecuritySection.staffAccessLog";

// ─── Password change ────────────────────────────────────────────────

type Rule = "length" | "upper" | "number" | "special" | "match";
const RULE_LABELS: Record<Rule, string> = {
  length: "At least 10 characters",
  upper: "One uppercase letter",
  number: "One number",
  special: "One special character",
  match: "Passwords match",
};

function validate(pw: string, confirm: string): Record<Rule, boolean> {
  return {
    length: pw.length >= 10,
    upper: /[A-Z]/.test(pw),
    number: /\d/.test(pw),
    special: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw),
    match: pw.length > 0 && pw === confirm,
  };
}

function PasswordChange({ onToast }: { onToast: (msg: string, type: "success" | "error") => void }) {
  const [showForm, setShowForm] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const rules = validate(pw, confirm);
  const allValid = Object.values(rules).every(Boolean);

  const reset = () => {
    setPw("");
    setConfirm("");
  };

  const submit = async () => {
    if (!allValid || saving) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      onToast("Password updated successfully", "success");
      reset();
      setShowForm(false);
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to update password", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!showForm) {
    return (
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-border-subtle">
        <div>
          <p className="text-sm font-semibold text-text-main">Password</p>
          <p className="text-xs text-text-muted">Managed via Supabase Auth</p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-white border border-border-subtle text-text-main text-sm font-medium rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors shadow-sm"
        >
          Change Password
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-border-subtle space-y-4">
      <div>
        <label className="block text-xs font-bold text-text-secondary uppercase tracking-wider mb-2">
          New Password
        </label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Minimum 10 characters"
          className="w-full rounded-lg border border-border-subtle bg-white text-text-main text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary h-11 px-4 shadow-sm outline-none"
        />
      </div>
      <div>
        <label className="block text-xs font-bold text-text-secondary uppercase tracking-wider mb-2">
          Confirm Password
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Re-enter new password"
          className="w-full rounded-lg border border-border-subtle bg-white text-text-main text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary h-11 px-4 shadow-sm outline-none"
        />
      </div>
      <ul className="text-xs space-y-1">
        {(Object.keys(RULE_LABELS) as Rule[]).map((key) => {
          const ok = rules[key];
          return (
            <li
              key={key}
              className={`flex items-center gap-1.5 ${ok ? "text-secondary" : "text-text-muted"}`}
            >
              <span
                className="material-symbols-outlined text-[14px]"
                style={ok ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {ok ? "check_circle" : "circle"}
              </span>
              {RULE_LABELS[key]}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!allValid || saving}
          className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-lg transition-colors shadow-card disabled:opacity-50"
        >
          {saving ? "Updating..." : "Update Password"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setShowForm(false);
          }}
          className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── MFA / 2FA ──────────────────────────────────────────────────────

interface MfaEnrollData {
  id: string;
  qrCode: string;
  secret: string;
}

function MfaSection({ onToast }: { onToast: (msg: string, type: "success" | "error") => void }) {
  const [hasMFA, setHasMFA] = useState<boolean | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<MfaEnrollData | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  const refresh = async () => {
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return;
    const verified = data.totp.filter((f) => f.status === "verified");
    setHasMFA(verified.length > 0);
    setFactorId(verified[0]?.id || null);
  };

  useEffect(() => {
    // refresh() awaits Supabase listFactors — its setStates run in
    // deferred async callbacks, not synchronously during this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, []);

  const startEnroll = async () => {
    setEnrollError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      issuer: "PE OS",
    });
    if (error || !data) {
      setEnrollError(error?.message || "Failed to start enrollment");
      return;
    }
    setEnroll({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode("");
  };

  const confirmEnroll = async () => {
    if (!enroll || code.length !== 6 || verifying) return;
    setEnrollError(null);
    setVerifying(true);
    const supabase = createClient();
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enroll.id });
    if (chErr || !ch) {
      setEnrollError(chErr?.message || "Challenge failed");
      setVerifying(false);
      return;
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: enroll.id,
      challengeId: ch.id,
      code,
    });
    setVerifying(false);
    if (error) {
      setEnrollError("Invalid code. Make sure your authenticator is synced and try again.");
      setCode("");
      return;
    }
    setEnroll(null);
    setCode("");
    onToast("Two-factor authentication enabled!", "success");
    refresh();
  };

  const cancelEnroll = async () => {
    if (enroll) {
      const supabase = createClient();
      await supabase.auth.mfa.unenroll({ factorId: enroll.id }).catch(() => {});
    }
    setEnroll(null);
    setCode("");
    setEnrollError(null);
  };

  const disable = async () => {
    if (!factorId) return;
    const supabase = createClient();
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setShowDisableConfirm(false);
    if (error) {
      onToast(`Failed to disable 2FA: ${error.message}`, "error");
      return;
    }
    onToast("Two-factor authentication disabled", "success");
    refresh();
  };

  return (
    <div className="border-t border-border-subtle pt-4">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-border-subtle">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-text-secondary">security</span>
          <div>
            <p className="text-sm font-semibold text-text-main">
              Two-Factor Authentication (2FA)
            </p>
            <p
              className={`text-xs ${
                hasMFA ? "text-green-600 font-medium" : "text-text-muted"
              }`}
            >
              {hasMFA === null
                ? "Loading..."
                : hasMFA
                  ? "Enabled — Your account is protected with 2FA"
                  : "Not enabled — Add an extra layer of security"}
            </p>
          </div>
        </div>
        {hasMFA !== null && (
          hasMFA ? (
            <button
              type="button"
              onClick={() => setShowDisableConfirm(true)}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors shadow-sm border border-red-200 text-red-600 bg-white hover:bg-red-50"
            >
              Disable
            </button>
          ) : (
            <button
              type="button"
              onClick={startEnroll}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors shadow-sm border border-border-subtle bg-white hover:bg-gray-50 text-text-main"
            >
              Enable
            </button>
          )
        )}
      </div>

      {enroll && (
        <div className="mt-4 p-5 bg-gray-50 rounded-lg border border-border-subtle space-y-4">
          <div className="text-center">
            <p className="text-sm font-semibold text-text-main mb-1">Set Up Authenticator App</p>
            <p className="text-xs text-text-muted">
              Scan this QR code with Google Authenticator, Authy, or any TOTP app
            </p>
          </div>
          <div className="flex justify-center">
            {/* QR code is a data URL from Supabase; <img> is fine */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enroll.qrCode}
              alt="MFA QR Code"
              className="w-48 h-48 rounded-lg border border-border-subtle bg-white p-2"
            />
          </div>
          <div className="text-center">
            <p className="text-xs text-text-muted mb-1">Or enter this key manually:</p>
            <code className="text-xs font-mono bg-white px-3 py-1.5 rounded border border-border-subtle select-all">
              {enroll.secret}
            </code>
          </div>
          <div>
            <label className="block text-xs font-bold text-text-secondary uppercase tracking-wider mb-2">
              Enter 6-digit code to verify
            </label>
            <input
              type="text"
              maxLength={6}
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="w-full rounded-lg border border-border-subtle bg-white text-text-main text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary h-11 px-4 shadow-sm text-center tracking-[0.5em] font-mono outline-none"
            />
          </div>
          {enrollError && (
            <div className="text-red-600 text-xs bg-red-50 border border-red-200 p-2 rounded">
              {enrollError}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={confirmEnroll}
              disabled={code.length !== 6 || verifying}
              className="px-5 py-2.5 text-white text-sm font-semibold rounded-lg transition-colors shadow-card disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              {verifying ? "Verifying..." : "Verify & Enable 2FA"}
            </button>
            <button
              type="button"
              onClick={cancelEnroll}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showDisableConfirm && (
        <div className="mt-4 p-4 bg-red-50 rounded-lg border border-red-200 space-y-3">
          <p className="text-sm font-semibold text-red-800">
            Disable Two-Factor Authentication?
          </p>
          <p className="text-xs text-red-600">
            This will make your account less secure. You can re-enable it anytime.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={disable}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Yes, Disable 2FA
            </button>
            <button
              type="button"
              onClick={() => setShowDisableConfirm(false)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-main transition-colors"
            >
              Keep Enabled
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Public component ───────────────────────────────────────────────

export function SecuritySection({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  return (
    <section
      id="section-security"
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
    >
      <div className="px-6 py-5 border-b border-border-subtle flex items-center gap-3">
        <div className="p-2 bg-gray-100 rounded-lg text-text-secondary border border-border-subtle">
          <span className="material-symbols-outlined text-[20px] block">shield</span>
        </div>
        <div>
          <h2 className="text-base font-bold text-text-main">Security</h2>
          <p className="text-xs text-text-muted">
            Manage your password and account security settings.
          </p>
        </div>
      </div>
      <div className="p-6 space-y-4">
        <PasswordChange onToast={onToast} />
        <MfaSection onToast={onToast} />
        <TrustPosture />
        <StaffAccessLog onToast={onToast} />
        <ActiveSessions onToast={onToast} />
        <IsolationTest onToast={onToast} />
      </div>
    </section>
  );
}
