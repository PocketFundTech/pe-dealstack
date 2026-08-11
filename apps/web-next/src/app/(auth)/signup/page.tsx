"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";

const STRENGTH_COLORS = ["bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-green-500"];
const STRENGTH_LABELS = ["Weak", "Fair", "Good", "Strong"];

function computeStrength(password: string): number {
  let s = 0;
  if (password.length >= 10) s++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
  if (/[0-9]/.test(password)) s++;
  if (/[^A-Za-z0-9]/.test(password)) s++;
  return s;
}

const STATS = [
  { value: "< 3min", label: "To first insight" },
  { value: "No prompts", label: "Pre-loaded context" },
  { value: "SOC 2", label: "Enterprise ready" },
];

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firmName, setFirmName] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();

  const strength = useMemo(() => computeStrength(password), [password]);
  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

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
      setError("Password needs uppercase, lowercase, number, and special character.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          firm_name: firmName,
        },
      },
    });

    if (authError) {
      let msg = "An error occurred. Please try again.";
      if (authError.message.includes("already registered")) {
        msg = "An account with this email already exists. Please log in.";
      } else {
        msg = authError.message;
      }
      setError(msg);
      setLoading(false);
      return;
    }

    if (data.session) {
      setSuccess("Account created! Redirecting to setup...");
      setTimeout(() => router.push("/onboarding"), 1200);
    } else {
      setSuccess("Check your email to verify your account, then log in.");
      setLoading(true); // keep button disabled
    }
  };

  const inputClass =
    "w-full px-3 py-2.5 text-[14px] rounded-lg border border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary outline-none transition";

  return (
    <div className="min-h-screen flex flex-col bg-background-body text-text-main font-sans">
      {/* Top Nav */}
      <header className="bg-white border-b border-border-subtle">
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 12L12 22L22 12L12 2Z" fill="#003366" />
            </svg>
            <span className="font-display font-bold text-[15px] tracking-tight text-primary">
              PE OS
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-[13px] text-text-secondary hidden sm:inline">
              Already have an account?
            </span>
            <Link
              href="/login"
              className="text-[13px] font-semibold text-primary hover:text-primary-hover transition"
            >
              Log in
            </Link>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[440px]">
          {/* Header */}
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary-light text-primary text-[11px] font-semibold uppercase tracking-wider mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
              Secure registration
            </div>
            <h1 className="font-display text-[32px] leading-[1.15] font-bold tracking-tight text-text-main">
              Create your workspace
            </h1>
            <p className="mt-2 text-[14px] text-text-secondary">
              Set up your PE OS account in under a minute.
            </p>
          </div>

          {/* Form Card */}
          <div className="bg-white border border-border-subtle rounded-xl shadow-card p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Full Name */}
              <div>
                <label
                  className="block text-[12px] font-medium text-text-secondary mb-1.5"
                  htmlFor="fullname"
                >
                  Full name
                </label>
                <input
                  id="fullname"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className={inputClass}
                  placeholder="Jane Smith"
                  required
                />
              </div>

              {/* Work Email */}
              <div>
                <label
                  className="block text-[12px] font-medium text-text-secondary mb-1.5"
                  htmlFor="email"
                >
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="jane@meridian.com"
                  required
                />
              </div>

              {/* Firm Name */}
              <div>
                <label
                  className="block text-[12px] font-medium text-text-secondary mb-1.5"
                  htmlFor="firmname"
                >
                  Firm name
                </label>
                <input
                  id="firmname"
                  type="text"
                  value={firmName}
                  onChange={(e) => setFirmName(e.target.value)}
                  className={inputClass}
                  placeholder="Meridian Capital Partners"
                  required
                />
              </div>

              {/* Password */}
              <div>
                <label
                  className="block text-[12px] font-medium text-text-secondary mb-1.5"
                  htmlFor="password"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${inputClass} pr-10`}
                    placeholder="Min 10 chars, upper + lower + number + special"
                    required
                    minLength={10}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                {/* Strength bar */}
                {password.length > 0 && (
                  <div className="mt-2">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded transition-colors ${
                            i <= strength ? STRENGTH_COLORS[strength - 1] : "bg-gray-200"
                          }`}
                        />
                      ))}
                    </div>
                    {strength > 0 && (
                      <p className="text-[11px] mt-1 text-text-muted">
                        {STRENGTH_LABELS[strength - 1]}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Confirm Password */}
              <div>
                <label
                  className="block text-[12px] font-medium text-text-secondary mb-1.5"
                  htmlFor="confirm_password"
                >
                  Confirm password
                </label>
                <input
                  id="confirm_password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClass}
                  placeholder="Re-enter password"
                  required
                />
                {confirmPassword.length > 0 && (
                  <p
                    className={`text-[11px] mt-1 ${
                      passwordsMatch ? "text-green-600" : "text-red-500"
                    }`}
                  >
                    {passwordsMatch ? "Passwords match" : "Passwords do not match"}
                  </p>
                )}
              </div>

              {/* Error / Success */}
              {error && (
                <div className="text-[13px] text-red-600 bg-red-50 p-3 rounded-lg text-center">
                  {error}
                </div>
              )}
              {success && (
                <div className="text-[13px] text-secondary bg-secondary-light p-3 rounded-lg text-center">
                  {success}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 text-[14px] font-semibold text-white rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: "#003366" }}
              >
                <span>{loading ? "Creating workspace..." : "Create workspace"}</span>
                {loading && (
                  <svg
                    className="animate-spin h-4 w-4 text-white"
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
          </div>

          {/* Footer */}
          <p className="text-[11px] text-center text-text-muted mt-4 leading-relaxed">
            By creating a workspace you agree to our{" "}
            <Link href="/terms-of-service" className="text-primary hover:underline">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
          <p className="text-[11px] text-center text-text-muted mt-2">
            <Link href="/security" className="hover:text-primary transition-colors">
              Your data is secured →
            </Link>
          </p>

          {/* Stats row */}
          <div className="mt-8 pt-6 border-t border-border-subtle grid grid-cols-3 gap-4 text-center">
            {STATS.map((stat) => (
              <div key={stat.label}>
                <div className="font-display text-[18px] font-bold text-primary">
                  {stat.value}
                </div>
                <div className="text-[10px] text-text-muted uppercase tracking-wider mt-0.5">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
