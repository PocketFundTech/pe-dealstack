"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface MfaEnrollData {
  id: string;
  qrCode: string;
  secret: string;
}

export function MfaLockoutGate({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const handler = () => setLocked(true);
    window.addEventListener("pf:mfa-required", handler);
    return () => window.removeEventListener("pf:mfa-required", handler);
  }, []);

  if (!locked) return <>{children}</>;
  return <MfaLockoutScreen />;
}

function MfaLockoutScreen() {
  const [enroll, setEnroll] = useState<MfaEnrollData | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const startEnroll = async () => {
    setError(null);
    setStarting(true);
    const supabase = createClient();
    const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      issuer: "Pocket Fund",
    });
    setStarting(false);
    if (enrollErr || !data) {
      setError(enrollErr?.message || "Failed to start enrollment");
      return;
    }
    setEnroll({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode("");
  };

  const confirmEnroll = async () => {
    if (!enroll || code.length !== 6 || verifying) return;
    setError(null);
    setVerifying(true);
    const supabase = createClient();
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enroll.id });
    if (chErr || !ch) {
      setError(chErr?.message || "Challenge failed");
      setVerifying(false);
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: enroll.id,
      challengeId: ch.id,
      code,
    });
    setVerifying(false);
    if (verifyErr) {
      setError("Invalid code. Make sure your authenticator clock is in sync and try again.");
      setCode("");
      return;
    }
    setSuccess(true);
    setTimeout(() => window.location.reload(), 1200);
  };

  const cancelEnroll = async () => {
    if (enroll) {
      const supabase = createClient();
      await supabase.auth.mfa.unenroll({ factorId: enroll.id }).catch(() => {});
    }
    setEnroll(null);
    setCode("");
    setError(null);
  };

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut().catch(() => {});
    window.location.href = "/login";
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#F8F9FA] p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-2xl bg-white border border-border-subtle shadow-card">
        <div className="px-6 pt-6 pb-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-xl">shield_lock</span>
            </div>
            <div>
              <h1 className="text-base font-semibold text-text-main">
                Two-factor authentication required
              </h1>
              <p className="text-xs text-text-muted mt-0.5">
                Your firm requires 2FA before you can continue.
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          {success ? (
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-center">
              <p className="text-sm font-semibold text-green-800">2FA enabled</p>
              <p className="text-xs text-green-700 mt-1">Reloading…</p>
            </div>
          ) : !enroll ? (
            <>
              <p className="text-sm text-text-secondary leading-relaxed">
                Add a one-time-passcode authenticator (Google Authenticator, 1Password, Authy, etc.)
                to your account. It only takes a minute.
              </p>
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}
              <button
                type="button"
                onClick={startEnroll}
                disabled={starting}
                className="w-full px-4 py-2.5 text-white text-sm font-semibold rounded-lg shadow-card transition-colors disabled:opacity-60"
                style={{ backgroundColor: "#003366" }}
              >
                {starting ? "Starting…" : "Set up 2FA"}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted text-center">
                Scan this QR code with your authenticator app
              </p>
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enroll.qrCode}
                  alt="2FA QR Code"
                  className="w-44 h-44 rounded-lg border border-border-subtle bg-white p-2"
                />
              </div>
              <div className="text-center">
                <p className="text-[11px] text-text-muted mb-1">Or enter this key manually</p>
                <code className="text-xs font-mono bg-gray-50 px-3 py-1.5 rounded border border-border-subtle select-all break-all inline-block">
                  {enroll.secret}
                </code>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-text-secondary uppercase tracking-wider mb-2">
                  6-digit code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="w-full rounded-lg border border-border-subtle bg-white text-text-main text-base font-medium focus:border-primary focus:ring-1 focus:ring-primary h-12 px-4 shadow-sm text-center tracking-[0.5em] font-mono outline-none"
                />
              </div>
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={confirmEnroll}
                  disabled={code.length !== 6 || verifying}
                  className="flex-1 px-4 py-2.5 text-white text-sm font-semibold rounded-lg shadow-card transition-colors disabled:opacity-50"
                  style={{ backgroundColor: "#003366" }}
                >
                  {verifying ? "Verifying…" : "Verify & enable"}
                </button>
                <button
                  type="button"
                  onClick={cancelEnroll}
                  className="px-4 py-2.5 text-sm text-text-muted hover:text-text-main transition-colors"
                >
                  Back
                </button>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-border-subtle bg-gray-50 rounded-b-2xl flex items-center justify-between">
          <p className="text-[11px] text-text-muted">
            Need help? Contact your firm admin.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="text-[11px] font-medium text-text-secondary hover:text-text-main transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
