"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/layout/Logo";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import OtpCodeEntry from "./OtpCodeEntry";

const RESEND_COOLDOWN = 60;

type PageState = "loading" | "code-entry" | "success" | "error";

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><span className="material-symbols-rounded animate-spin text-3xl text-primary">progress_activity</span></div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [errorMessage, setErrorMessage] = useState("");

  // Code-entry initial data
  const [codeEmail, setCodeEmail] = useState("");
  const [hasPrefilledEmail, setHasPrefilledEmail] = useState(false);

  // Error-state resend form
  const [resendEmail, setResendEmail] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState("");
  const [resendMessageType, setResendMessageType] = useState<"success" | "error">("error");
  const [resendLoading, setResendLoading] = useState(false);

  // Success countdown
  const [countdown, setCountdown] = useState(5);

  /* ---- URL-based auto-verify on mount ---- */
  useEffect(() => {
    async function autoVerify() {
      const supabase = createClient();

      // Check for errors in URL (hash or query params)
      const hashParams = new URLSearchParams(
        typeof window !== "undefined" ? window.location.hash.substring(1) : ""
      );

      const urlError = hashParams.get("error") || searchParams.get("error");
      const urlErrorDescription =
        hashParams.get("error_description") || searchParams.get("error_description");

      if (urlError) {
        setErrorMessage(urlErrorDescription || "Email verification failed. Please try again.");
        setPageState("error");
        return;
      }

      // Check for token_hash (email verification link format)
      const tokenHash = searchParams.get("token_hash");
      const type = searchParams.get("type");

      if (tokenHash && type === "email") {
        const { data, error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "email",
        });

        if (verifyError) {
          setErrorMessage(
            verifyError.message || "Email verification failed. The link may have expired."
          );
          setPageState("error");
          return;
        }

        if (data.user) {
          setPageState("success");
          return;
        }
      }

      // Check for access_token in hash (implicit flow)
      const accessToken = hashParams.get("access_token");
      if (accessToken) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Check current user status
      const { data: userData } = await supabase.auth.getUser();
      const user = userData?.user;

      if (user && user.email_confirmed_at) {
        setPageState("success");
      } else if (tokenHash || accessToken) {
        setErrorMessage("This verification link is invalid or has expired.");
        setPageState("error");
      } else {
        // No token in URL -- show code-entry form for manual OTP
        if (user?.email) {
          setCodeEmail(user.email);
          setHasPrefilledEmail(true);
        }
        setPageState("code-entry");
      }
    }

    autoVerify().catch(() => {
      setErrorMessage("An error occurred during verification. Please try again.");
      setPageState("error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Success countdown redirect ---- */
  useEffect(() => {
    if (pageState !== "success") return;
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          window.location.href = "/login";
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [pageState]);

  /* ---- Error-state resend cooldown ticker ---- */
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  /* ---- Error-state resend handler ---- */
  const handleErrorResend = useCallback(async () => {
    const email = resendEmail.trim();
    if (!email) {
      setResendMessage("Please enter your email address.");
      setResendMessageType("error");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setResendMessage("Please enter a valid email address.");
      setResendMessageType("error");
      return;
    }

    setResendLoading(true);
    setResendMessage("");

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({ type: "signup", email });

      if (error) {
        setResendMessage(error.message || "Failed to send verification email.");
        setResendMessageType("error");
      } else {
        setResendMessage("Verification email sent! Check your inbox.");
        setResendMessageType("success");
        setResendCooldown(RESEND_COOLDOWN);
      }
    } catch (err) {
      console.warn("[auth/verify-email] resend failed:", err);
      setResendMessage("An error occurred. Please try again.");
      setResendMessageType("error");
    } finally {
      setResendLoading(false);
    }
  }, [resendEmail]);

  const handleCodeVerified = useCallback(() => {
    setPageState("success");
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background-body font-sans text-text-main">
      {/* Header */}
      <header className="w-full border-b border-border-subtle bg-white sticky top-0 z-50">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 cursor-pointer select-none">
            <Logo className="size-8 text-primary" />
            <h2 className="text-xl font-bold leading-tight tracking-tight">Avise</h2>
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        {/* Loading State */}
        {pageState === "loading" && (
          <div className="w-full max-w-[440px] bg-white rounded-xl shadow-sm border border-border-subtle p-8 text-center">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center">
                <svg
                  className="animate-spin h-10 w-10 text-primary"
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
              </div>
            </div>
            <h1 className="text-xl font-medium text-text-main">Verifying your email...</h1>
          </div>
        )}

        {/* Success State */}
        {pageState === "success" && (
          <div className="w-full max-w-[440px] bg-white rounded-xl shadow-sm border border-border-subtle p-8 text-center">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center animate-[checkmark_0.5s_ease-out_forwards]">
                <span className="material-symbols-outlined text-green-600 text-4xl">
                  check_circle
                </span>
              </div>
            </div>

            <h1 className="text-2xl font-bold text-text-main mb-2">Email Verified!</h1>
            <p className="text-gray-500 text-sm mb-6">
              Your email has been successfully verified. You can now sign in to your account.
            </p>

            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 w-full text-white font-medium rounded-lg h-12 transition-all duration-200 hover:opacity-90"
              style={{ backgroundColor: "#003366" }}
            >
              <span>Continue to Login</span>
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </Link>

            <p className="text-xs text-text-muted mt-4">
              Redirecting to login in <span className="font-medium">{countdown}</span> seconds...
            </p>
          </div>
        )}

        {/* Error State */}
        {pageState === "error" && (
          <div className="w-full max-w-[440px] bg-white rounded-xl shadow-sm border border-border-subtle p-8 text-center">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
                <span className="material-symbols-outlined text-red-600 text-4xl">error</span>
              </div>
            </div>

            <h1 className="text-2xl font-bold text-text-main mb-2">Verification Failed</h1>
            <p className="text-gray-500 text-sm mb-4">{errorMessage}</p>

            {/* Resend Email Form */}
            <div className="mb-4">
              <p className="text-text-secondary text-sm mb-3">
                Enter your email to receive a new verification link:
              </p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
                />
                <button
                  onClick={handleErrorResend}
                  disabled={resendLoading || resendCooldown > 0}
                  className="text-white font-medium rounded-lg px-4 py-2 text-sm transition-all duration-200 disabled:opacity-50"
                  style={{ backgroundColor: "#003366" }}
                >
                  {resendLoading
                    ? "Sending..."
                    : resendCooldown > 0
                      ? `Resend (${resendCooldown}s)`
                      : "Resend"}
                </button>
              </div>
              {resendMessage && (
                <p
                  className={`text-sm mt-2 ${
                    resendMessageType === "success" ? "text-green-600" : "text-red-500"
                  }`}
                >
                  {resendMessage}
                </p>
              )}
            </div>

            {/* Divider */}
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border-subtle" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-2 text-text-muted">or</span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 w-full bg-white hover:bg-gray-50 text-text-main border border-border-subtle font-medium rounded-lg h-12 transition-all duration-200"
              >
                Sign Up Again
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-2 w-full bg-white hover:bg-gray-50 text-text-main border border-border-subtle font-medium rounded-lg h-12 transition-all duration-200"
              >
                Go to Login
              </Link>
            </div>
          </div>
        )}

        {/* Code Entry State */}
        {pageState === "code-entry" && (
          <OtpCodeEntry
            initialEmail={codeEmail}
            hasPrefilledEmail={hasPrefilledEmail}
            onVerified={handleCodeVerified}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="w-full py-6 text-center text-xs text-text-muted">
        &copy; 2026 Avise. All rights reserved.
      </footer>
    </div>
  );
}
