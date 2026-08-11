"use client";

import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";

// Order, icons, copy mirror login.html on main (commit 37a3392).
const AI_AGENTS = [
  { name: "Financial Extractor", desc: "Auto-parses CIMs & balance sheets in seconds", icon: "table_chart", color: "#4F7CFF" },
  { name: "Deal Chat AI", desc: "Ask anything — instant answers from your data", icon: "smart_toy", color: "#A855F7" },
  { name: "Memo Builder", desc: "Drafts IC memos in minutes, not weeks", icon: "description", color: "#10B981" },
  { name: "Quality of Earnings", desc: "Detects red flags, validates EBITDA quality", icon: "verified", color: "#F59E0B" },
  { name: "Portfolio Monitor", desc: "24/7 signal scanning across holdings", icon: "monitoring", color: "#F43F5E" },
  { name: "Meeting Prep", desc: "Briefs auto-generated before every call", icon: "event_note", color: "#14B8A6" },
];

const STATS = [
  { value: "10x", label: "Faster diligence" },
  { value: "15hrs", label: "Saved per deal" },
  { value: "SOC 2", label: "Enterprise ready" },
];

const MFA_DIGIT_COUNT = 6;

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaDigits, setMfaDigits] = useState<string[]>(Array(MFA_DIGIT_COUNT).fill(""));
  const [mfaError, setMfaError] = useState("");
  const [mfaVerifying, setMfaVerifying] = useState(false);
  const mfaInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const router = useRouter();

  const showMfa = mfaFactorId !== null;
  const mfaCode = mfaDigits.join("");
  const mfaReady = mfaCode.length === MFA_DIGIT_COUNT;

  useEffect(() => {
    if (showMfa) mfaInputRefs.current[0]?.focus();
  }, [showMfa]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(mapAuthError(authError.message));
      setLoading(false);
      return;
    }

    // After password auth, check if the user has a verified TOTP factor.
    const { data: factorsData } = await supabase.auth.mfa.listFactors();
    const verified = factorsData?.totp.filter((f) => f.status === "verified") ?? [];
    if (verified.length > 0) {
      setMfaFactorId(verified[0].id);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
  };

  const handleMfaDigitChange = (index: number, raw: string) => {
    const val = raw.replace(/[^0-9]/g, "").slice(0, 1);
    setMfaDigits((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
    if (val && index < MFA_DIGIT_COUNT - 1) mfaInputRefs.current[index + 1]?.focus();
  };

  const handleMfaDigitKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !mfaDigits[index] && index > 0) {
      mfaInputRefs.current[index - 1]?.focus();
      setMfaDigits((prev) => {
        const next = [...prev];
        next[index - 1] = "";
        return next;
      });
    }
  };

  const handleMfaPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData("text") || "").replace(/[^0-9]/g, "").slice(0, MFA_DIGIT_COUNT);
    if (!pasted) return;
    const next = Array(MFA_DIGIT_COUNT).fill("").map((_, i) => pasted[i] ?? "");
    setMfaDigits(next);
    if (pasted.length === MFA_DIGIT_COUNT) mfaInputRefs.current[MFA_DIGIT_COUNT - 1]?.focus();
  };

  const handleMfaVerify = async () => {
    if (!mfaReady || !mfaFactorId) return;
    setMfaVerifying(true);
    setMfaError("");

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: mfaFactorId,
      code: mfaCode,
    });

    if (verifyError) {
      setMfaError("Invalid code. Please try again.");
      setMfaDigits(Array(MFA_DIGIT_COUNT).fill(""));
      mfaInputRefs.current[0]?.focus();
      setMfaVerifying(false);
      return;
    }

    router.push("/dashboard");
  };

  const handleMfaBack = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setMfaFactorId(null);
    setMfaDigits(Array(MFA_DIGIT_COUNT).fill(""));
    setMfaError("");
    setMfaVerifying(false);
  };

  const handleSso = () => {
    // Placeholder — real IdP wiring (Okta, Azure AD, etc.) lands later.
    // No user-facing message yet; the button click is a no-op until then.
  };

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* Left Panel — Branding */}
      <div className="hidden lg:flex w-1/2 relative flex-col items-center justify-center overflow-hidden" style={{ backgroundColor: "#0f1c2e" }}>
        <div
          className="absolute inset-0 z-0 opacity-20"
          style={{ backgroundImage: "radial-gradient(#ffffff 0.5px, transparent 0.5px)", backgroundSize: "24px 24px" }}
        />
        <div className="absolute inset-0 bg-gradient-to-tr from-[#0f1c2e] via-transparent to-white/10 z-0" />

        <div className="relative z-10 flex flex-col w-full max-w-2xl mx-auto px-12 py-16">
          {/* Header */}
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 mb-5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
              <span className="text-[11px] font-semibold text-emerald-300 uppercase tracking-wider">7 AI agents · Live</span>
            </div>
            <h2 className="text-4xl font-bold text-white tracking-tight leading-tight mb-3">
              Your AI deal team,<br />working 24/7.
            </h2>
            <p className="text-blue-100/70 text-base leading-relaxed max-w-md">
              Purpose-built AI agents for private equity. From sourcing to close &mdash; automate the work that bankers, analysts, and associates do every day.
            </p>
          </div>

          {/* AI Agents Grid */}
          <div className="grid grid-cols-2 gap-3 mb-8">
            {AI_AGENTS.map((agent) => (
              <div
                key={agent.name}
                className="group relative bg-white/5 hover:bg-white/10 backdrop-blur-sm border border-white/10 rounded-lg p-3.5 transition-all duration-300 hover:border-white/25 hover:-translate-y-0.5"
              >
                <div className="flex items-start gap-2.5">
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center border"
                    style={{ backgroundColor: `${agent.color}1F`, borderColor: `${agent.color}33` }}
                  >
                    <span
                      className="material-symbols-outlined text-[18px]"
                      style={{ color: agent.color, fontVariationSettings: "'FILL' 0, 'wght' 400" }}
                    >
                      {agent.icon}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-white mb-0.5">{agent.name}</p>
                    <p className="text-[10px] text-blue-100/60 leading-snug">{agent.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-4 pt-6 border-t border-white/10">
            {STATS.map((stat) => (
              <div key={stat.label}>
                <p className="text-2xl font-bold text-white tracking-tight">{stat.value}</p>
                <p className="text-[10px] text-blue-100/60 uppercase tracking-wider mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right Panel — Login Form / MFA */}
      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center bg-white px-6 md:px-12 lg:px-24 relative">
        <div className="absolute inset-0 lg:hidden pointer-events-none opacity-5 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

        <div className="w-full max-w-[440px] z-10">
          <div className="flex items-center gap-2 mb-10">
            <div className="w-8 h-8 rounded flex items-center justify-center text-white" style={{ backgroundColor: "#003366" }}>
              <span className="material-symbols-outlined text-[20px]">candlestick_chart</span>
            </div>
            <span className="text-xl font-bold tracking-tight" style={{ color: "#003366" }}>PE<span className="font-light opacity-80">OS</span></span>
          </div>

          {!showMfa ? (
            <>
              <div className="mb-8">
                <h1 className="text-[#121417] tracking-tight text-[28px] font-bold leading-tight mb-2">
                  Sign in to your account
                </h1>
                <p className="text-slate-500 text-sm">Welcome back! Please enter your details.</p>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                <label className="flex flex-col gap-1.5">
                  <p className="text-[#121417] text-sm font-medium">Business Email</p>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className="form-input w-full rounded-lg text-[#121417] border border-gray-200 bg-white h-12 placeholder:text-gray-400 px-4 text-sm transition-all focus:outline-0 focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    placeholder="name@firm.com"
                    required
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <p className="text-[#121417] text-sm font-medium">Password</p>
                  <div className="relative flex w-full rounded-lg group focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary border border-gray-200 bg-white transition-all">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="form-input flex-1 min-w-0 border-none bg-transparent h-12 text-[#121417] placeholder:text-gray-400 px-4 text-sm focus:ring-0"
                      placeholder="••••••••"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="pr-3 flex items-center justify-center text-gray-400 hover:text-primary transition-colors"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        {showPassword ? "visibility" : "visibility_off"}
                      </span>
                    </button>
                  </div>
                </label>

                <div className="flex justify-between items-center">
                  <label className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="rounded border-gray-300 text-primary focus:ring-primary/20 w-4 h-4"
                    />
                    <span className="text-sm text-slate-600 group-hover:text-slate-800 transition-colors">
                      Remember me
                    </span>
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-primary hover:text-blue-700 text-sm font-medium transition-colors"
                  >
                    Forgot password?
                  </Link>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 rounded-lg text-white font-medium text-sm shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#15304a] flex items-center justify-center gap-2 mt-2"
                  style={{ backgroundColor: "#003366" }}
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Signing in...
                    </span>
                  ) : (
                    <>
                      Sign In
                      <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                    </>
                  )}
                </button>

                {error && (
                  <div className="text-red-500 text-sm text-center bg-red-50 p-3 rounded-lg">
                    {error}
                  </div>
                )}
              </form>

              {/* Divider, SSO, and Sign Up — outside form, matches legacy loginExtras */}
              <div className="flex flex-col gap-5 mt-5">
                <div className="relative flex py-2 items-center">
                  <div className="flex-grow border-t border-gray-200" />
                  <span className="flex-shrink-0 mx-4 text-xs text-gray-400 font-medium uppercase tracking-wider">Or continue with</span>
                  <div className="flex-grow border-t border-gray-200" />
                </div>

                <button
                  type="button"
                  onClick={handleSso}
                  className="w-full h-12 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[#121417] font-medium text-sm transition-all duration-200 flex items-center justify-center gap-3"
                >
                  <span className="material-symbols-outlined text-[20px] text-primary">lock_person</span>
                  Single Sign-On (SSO)
                </button>

                <div className="text-center mt-2">
                  <p className="text-sm text-slate-500">
                    Don&apos;t have an account?{" "}
                    <Link href="/signup" className="text-primary font-medium hover:text-blue-700 transition-colors">
                      Sign up
                    </Link>
                  </p>
                  <p className="text-xs text-slate-400 mt-3">
                    <Link href="/security" className="hover:text-primary transition-colors inline-flex items-center gap-1">
                      Your data is secured
                      <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                    </Link>
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <span className="material-symbols-outlined text-primary text-[24px]">security</span>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-[#121417]">Two-Factor Authentication</h2>
                  <p className="text-sm text-slate-500">Enter the 6-digit code from your authenticator app</p>
                </div>
              </div>

              <div className="flex justify-center gap-2">
                {mfaDigits.map((digit, i) => (
                  <div key={i} className="flex items-center">
                    <input
                      ref={(el) => { mfaInputRefs.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      autoComplete={i === 0 ? "one-time-code" : undefined}
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleMfaDigitChange(i, e.target.value)}
                      onKeyDown={(e) => handleMfaDigitKeyDown(i, e)}
                      onPaste={handleMfaPaste}
                      className="w-12 h-14 text-center text-xl font-bold border border-gray-200 rounded-lg focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                    />
                    {i === 2 && <span className="ml-2 flex items-center text-gray-300 text-xl">-</span>}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={handleMfaVerify}
                disabled={!mfaReady || mfaVerifying}
                className="w-full h-12 rounded-lg text-white font-medium text-sm shadow-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#15304a] flex items-center justify-center gap-2"
                style={{ backgroundColor: "#003366" }}
              >
                {mfaVerifying ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Verifying...
                  </span>
                ) : (
                  "Verify Code"
                )}
              </button>

              {mfaError && (
                <div className="text-red-500 text-sm text-center bg-red-50 p-3 rounded-lg">
                  {mfaError}
                </div>
              )}

              <button
                type="button"
                onClick={handleMfaBack}
                className="text-sm text-slate-500 hover:text-primary transition-colors text-center"
              >
                Back to sign in
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-10 pt-6 border-t border-gray-100 flex items-center justify-center text-xs text-slate-400">
            <p>&copy; 2026 PE OS.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function mapAuthError(raw: string): string {
  if (raw.includes("Invalid login credentials")) return "Invalid email or password. Please try again.";
  if (raw.includes("Email not confirmed")) return "Please verify your email address before signing in.";
  return raw;
}
