"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: `${window.location.origin}/reset-password` }
      );

      if (authError) {
        throw authError;
      }

      setSubmitted(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to send reset email. Please try again.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background-body min-h-screen flex flex-col font-display text-text-main">
      {/* Header */}
      <header className="w-full border-b border-gray-200 bg-white sticky top-0 z-50">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-3 cursor-pointer select-none"
          >
            <div className="size-8 rounded bg-primary/10 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-2xl">
                bar_chart
              </span>
            </div>
            <h2 className="text-xl font-bold leading-tight tracking-tight">
              Avise
            </h2>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-primary hover:text-primary-hover font-medium text-sm transition-colors"
            >
              Back to Login
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-[440px] bg-white rounded-xl shadow-sm border border-gray-200 p-8 relative overflow-hidden">
          {/* Top accent bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary/80 to-primary" />

          {/* Icon */}
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-3xl">
                lock_reset
              </span>
            </div>
          </div>

          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-text-main mb-2">
              Forgot your password?
            </h1>
            <p className="text-gray-500 text-sm">
              No worries! Enter your email address and we&apos;ll send you a
              link to reset your password.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* Email Field */}
            <div className="space-y-2">
              <label
                className="text-sm font-medium text-text-main"
                htmlFor="email"
              >
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                  <span className="material-symbols-outlined text-[20px]">
                    mail
                  </span>
                </div>
                <input
                  className="block w-full rounded-lg border border-gray-200 bg-white text-text-main pl-10 pr-3 py-3 text-sm placeholder:text-gray-400 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all"
                  id="email"
                  name="email"
                  placeholder="name@firm.com"
                  type="email"
                  required
                  disabled={submitted}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="text-red-500 text-sm text-center bg-red-50 p-3 rounded-lg">
                {error}
              </div>
            )}

            {/* Success Message */}
            {submitted && (
              <div className="text-green-600 text-sm text-center bg-green-50 p-3 rounded-lg">
                <div className="flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">
                    check_circle
                  </span>
                  <span>Password reset email sent! Check your inbox.</span>
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || submitted}
              className="w-full h-12 rounded-lg text-white font-medium transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#003366" }}
              onMouseEnter={(e) => {
                if (!loading && !submitted)
                  e.currentTarget.style.backgroundColor = "#002855";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#003366";
              }}
            >
              <span>
                {submitted
                  ? "Email Sent"
                  : loading
                    ? "Sending..."
                    : "Send Reset Link"}
              </span>
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

            {/* Back to Login */}
            <div className="text-center">
              <Link
                href="/login"
                className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">
                  arrow_back
                </span>
                Back to Login
              </Link>
            </div>
          </form>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full py-6 text-center text-xs text-gray-400">
        &copy; 2026 Avise. All rights reserved.
      </footer>
    </div>
  );
}
