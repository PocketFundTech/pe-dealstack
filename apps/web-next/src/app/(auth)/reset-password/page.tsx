"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

/* ---------- Strength helpers (match legacy bars logic) ---------- */

function getStrength(pw: string): number {
  let s = 0;
  if (pw.length >= 10) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

const STRENGTH_COLORS = ["bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-green-500"];
const STRENGTH_LABELS = ["Weak", "Fair", "Good", "Strong"];
const STRENGTH_TEXT_COLORS = [
  "text-red-500",
  "text-orange-500",
  "text-yellow-600",
  "text-green-500",
];

/* ---------- Component ---------- */

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);
  const router = useRouter();

  const strength = getStrength(password);
  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;

  /* ---------- Session / token validation on mount ---------- */
  useEffect(() => {
    const checkSession = async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setTokenExpired(true);
        setError(
          "This password reset link is invalid or has expired. Please request a new one."
        );
      }
    };
    checkSession();
  }, []);

  /* ---------- Submit ---------- */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      setError(
        "Password must contain at least one uppercase letter and one number."
      );
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.updateUser({ password });

    if (authError) {
      let message = "Failed to update password. Please try again.";
      if (authError.message) {
        if (authError.message.includes("same as the old password")) {
          message = "New password must be different from your old password.";
        } else {
          message = authError.message;
        }
      }
      setError(message);
      setLoading(false);
      return;
    }

    api.post("/account/security/password-changed", {}).catch((err) =>
      console.warn("[security] password-changed email trigger failed:", err)
    );

    setSuccess(true);
    setLoading(false);
    setTimeout(() => router.push("/login"), 2000);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background-body font-sans text-text-main">
      {/* Header */}
      <header className="w-full border-b border-gray-200 bg-white sticky top-0 z-50">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 cursor-pointer select-none">
            <div className="size-8 rounded bg-primary/10 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-2xl">bar_chart</span>
            </div>
            <h2 className="text-xl font-bold leading-tight tracking-tight">Avise</h2>
          </Link>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-[440px] bg-white rounded-xl shadow-sm border border-gray-200 p-8 relative overflow-hidden">
          {/* Top accent bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary/80 to-primary" />

          {/* Key icon */}
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-3xl">key</span>
            </div>
          </div>

          {/* Heading */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-text-main mb-2">Set new password</h1>
            <p className="text-gray-500 text-sm">
              Create a strong password for your account.
            </p>
          </div>

          {/* Form (hidden on success) */}
          {!success && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {/* New Password */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-main" htmlFor="password">
                  New Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <span className="material-symbols-outlined text-[20px]">lock</span>
                  </div>
                  <input
                    className="block w-full rounded-lg border border-gray-200 bg-white text-text-main pl-10 pr-10 py-3 text-sm placeholder:text-gray-400 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all"
                    id="password"
                    name="password"
                    placeholder="••••••••"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={10}
                    disabled={tokenExpired}
                  />
                  <button
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 cursor-pointer"
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  Min 8 characters, one uppercase, one number
                </p>

                {/* Password strength bars */}
                {password.length > 0 && (
                  <div>
                    <div className="flex gap-1 mt-2">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded ${
                            i < strength ? STRENGTH_COLORS[strength - 1] : "bg-gray-200"
                          }`}
                        />
                      ))}
                    </div>
                    {strength > 0 && (
                      <p className={`text-xs mt-1 ${STRENGTH_TEXT_COLORS[strength - 1]}`}>
                        {STRENGTH_LABELS[strength - 1]}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Confirm Password */}
              <div className="space-y-2">
                <label
                  className="text-sm font-medium text-text-main"
                  htmlFor="confirmPassword"
                >
                  Confirm New Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <span className="material-symbols-outlined text-[20px]">lock_reset</span>
                  </div>
                  <input
                    className={`block w-full rounded-lg border bg-white text-text-main pl-10 pr-3 py-3 text-sm placeholder:text-gray-400 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all ${
                      confirmPassword.length > 0
                        ? passwordsMatch
                          ? "border-green-500"
                          : "border-red-500"
                        : "border-gray-200"
                    }`}
                    id="confirmPassword"
                    name="confirmPassword"
                    placeholder="••••••••"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={tokenExpired}
                  />
                </div>
                {confirmPassword.length > 0 && (
                  <p
                    className={`text-xs mt-1 ${
                      passwordsMatch ? "text-green-500" : "text-red-500"
                    }`}
                  >
                    {passwordsMatch ? "Passwords match" : "Passwords do not match"}
                  </p>
                )}
              </div>

              {/* Error message */}
              {error && (
                <div className="text-red-500 text-sm text-center bg-red-50 p-3 rounded-lg">
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading || tokenExpired}
                className="w-full h-12 rounded-lg text-white font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "#003366" }}
              >
                <span>{loading ? "Updating..." : "Update Password"}</span>
                {loading && (
                  <svg
                    className="animate-spin h-5 w-5 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
              </button>
            </form>
          )}

          {/* Success message (replaces form) */}
          {success && (
            <div className="text-green-600 text-sm text-center bg-green-50 p-3 rounded-lg">
              <div className="flex flex-col items-center gap-2">
                <span className="material-symbols-outlined text-2xl">check_circle</span>
                <span>Password updated successfully!</span>
                <span className="text-xs text-gray-500">Redirecting to login...</span>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full py-6 text-center text-xs text-gray-400">
        &copy; 2026 Avise. All rights reserved.
      </footer>
    </div>
  );
}
