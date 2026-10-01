"use client";

import { useState } from "react";
import Link from "next/link";
import { PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT, passwordError } from "@/lib/passwordRules";

export interface InviteSession {
  access_token: string;
  refresh_token: string;
}

const inputClass =
  "block w-full rounded-lg border border-[#dbe0e6] bg-white text-[#111418] pl-10 pr-3 py-3 text-sm placeholder:text-[#9ca3af] focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all shadow-sm";

function FieldIcon({ name }: { name: string }) {
  return (
    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#9ca3af]">
      <span className="material-symbols-outlined text-[20px]">{name}</span>
    </div>
  );
}

// New-account path: POST /public/invitations/accept/:token. The server creates
// an already-confirmed account (the emailed token proves the address) and
// returns a session for the page to apply.
export function CreateAccountForm({
  token,
  email,
  onCreated,
  onAccountExists,
}: {
  token: string;
  email: string;
  onCreated: (session: InviteSession | null) => Promise<void> | void;
  onAccountExists: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!fullName.trim()) {
      setFormError("Please enter your full name");
      return;
    }
    const pwError = passwordError(password);
    if (pwError) {
      setFormError(pwError);
      return;
    }
    if (password !== confirmPassword) {
      setFormError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/invitations/accept/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, fullName: fullName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "ACCOUNT_EXISTS") {
        onAccountExists();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || "Failed to create account");
      }
      await onCreated(data.session ?? null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to create account");
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleAccept} className="flex flex-col gap-5">
        <div className="space-y-2">
          <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-email">Email</label>
          <div className="relative">
            <FieldIcon name="mail" />
            <input
              id="invite-email"
              type="email"
              value={email}
              readOnly
              className="block w-full rounded-lg border-[#dbe0e6] bg-gray-100 text-[#617289] pl-10 pr-3 py-3 text-sm cursor-not-allowed border"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-fullname">Full Name</label>
          <div className="relative">
            <FieldIcon name="person" />
            <input
              id="invite-fullname"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className={inputClass}
              placeholder="Your full name"
              required
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-password">Create Password</label>
          <div className="relative">
            <FieldIcon name="lock" />
            <input
              id="invite-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${inputClass} pr-10`}
              placeholder="••••••••"
              required
              minLength={PASSWORD_MIN_LENGTH}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-[#9ca3af] hover:text-[#617289] cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">
                {showPassword ? "visibility_off" : "visibility"}
              </span>
            </button>
          </div>
          <p className="text-xs text-[#617289] mt-1">{PASSWORD_RULE_TEXT}</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-confirm-password">Confirm Password</label>
          <div className="relative">
            <FieldIcon name="lock" />
            <input
              id="invite-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
              required
              minLength={PASSWORD_MIN_LENGTH}
            />
          </div>
        </div>

        {formError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-600">{formError}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 px-4 rounded-lg text-white text-sm font-semibold hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          {submitting ? (
            <>
              <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              Creating account...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[20px]">how_to_reg</span>
              Create Account &amp; Join
            </>
          )}
        </button>
      </form>

      <p className="text-xs text-center text-[#617289] mt-6">
        By creating an account, you agree to our{" "}
        <Link href="/terms-of-service" className="text-primary hover:underline">Terms of Service</Link>
        {" "}and{" "}
        <Link href="/privacy-policy" className="text-primary hover:underline">Privacy Policy</Link>.
      </p>
    </>
  );
}
