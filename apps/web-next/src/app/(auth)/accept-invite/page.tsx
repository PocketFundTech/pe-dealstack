"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Logo } from "@/components/layout/Logo";
import Link from "next/link";

interface InviteData {
  email: string;
  firmName: string;
  organizationLogo: string | null;
  role: string;
  inviter: { name: string; avatar?: string } | null;
}

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") || "";

  const [status, setStatus] = useState<"loading" | "valid" | "invalid" | "accepted">("loading");
  const [errorMessage, setErrorMessage] = useState("This invitation link is invalid or has expired.");
  const [invitation, setInvitation] = useState<InviteData | null>(null);

  // Form state
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setErrorMessage("No invitation token provided. Please use the link from your invitation email.");
      setStatus("invalid");
      return;
    }
    verifyInvitation(token);
  }, [token]);

  async function verifyInvitation(t: string) {
    try {
      const res = await fetch(`/api/public/invitations/verify/${t}`);
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || "Invalid invitation");
        setStatus("invalid");
        return;
      }
      setInvitation({
        email: data.email,
        firmName: data.firmName,
        organizationLogo: data.organizationLogo || null,
        role: data.role,
        inviter: data.inviter || null,
      });
      setStatus("valid");
    } catch (err) {
      console.warn("[auth/accept-invite] failed to verify invitation:", err);
      setErrorMessage("Unable to verify invitation. Please try again later.");
      setStatus("invalid");
    }
  }

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!fullName.trim()) {
      setFormError("Please enter your full name");
      return;
    }
    if (password.length < 10) {
      setFormError("Password must be at least 10 characters with uppercase, lowercase, number, and special character");
      return;
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setFormError("Password must contain uppercase, lowercase, number, and special character");
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
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create account");
      }
      setStatus("accepted");
      // If session returned (auto-confirmed), redirect to dashboard
      if (data.session) {
        setTimeout(() => router.push("/dashboard"), 2000);
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to create account");
      setSubmitting(false);
    }
  }

  const inviterName = invitation?.inviter?.name || "A team member";

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA]">
      {/* Header */}
      <header className="w-full border-b border-[#e5e7eb] bg-white sticky top-0 z-50">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 text-[#111418] cursor-pointer select-none">
            <Logo className="size-8 text-primary" />
            <h2 className="text-xl font-bold leading-tight tracking-tight">Avise</h2>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-[#617289] hidden sm:block">
              Already have an account?
            </span>
            <Link href="/login" className="text-primary hover:text-primary/80 font-bold text-sm transition-colors">
              Log in
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        {/* Loading State */}
        {status === "loading" && (
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-[#e5e7eb] p-8 sm:p-10 text-center">
            <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
            <p className="text-[#617289]">Verifying invitation...</p>
          </div>
        )}

        {/* Error State */}
        {status === "invalid" && (
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-[#e5e7eb] p-8 sm:p-10 text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-red-500 text-3xl">error</span>
            </div>
            <h2 className="text-xl font-bold text-[#111418] mb-2">Invalid Invitation</h2>
            <p className="text-[#617289] mb-6">{errorMessage}</p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 px-4 py-2 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-colors"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-[18px]">login</span>
              Go to Login
            </Link>
          </div>
        )}

        {/* Accept Form */}
        {status === "valid" && invitation && (
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-[#e5e7eb] p-8 sm:p-10 relative overflow-hidden">
            {/* Top accent bar */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary/80 to-primary" />

            {/* Header Section */}
            <div className="mb-8 text-center">
              {invitation.organizationLogo && (
                <img
                  src={invitation.organizationLogo}
                  alt={invitation.firmName}
                  className="w-16 h-16 rounded-xl object-contain mx-auto mb-4 border border-[#e5e7eb]"
                />
              )}
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-50 text-green-600 text-xs font-semibold mb-4 border border-green-200">
                <span className="material-symbols-outlined text-[14px]">check_circle</span>
                Valid Invitation
              </div>
              <h1 className="text-2xl sm:text-[28px] font-bold text-[#111418] leading-tight mb-3">
                You&apos;re Invited!
              </h1>
              <p className="text-[#617289] text-sm sm:text-base">
                <span className="font-semibold text-[#111418]">{inviterName}</span> has invited you to join{" "}
                <span className="font-semibold text-[#111418]">{invitation.firmName}</span>
              </p>
            </div>

            {/* Invitation Details */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0 overflow-hidden">
                  {invitation.inviter?.avatar ? (
                    <img
                      src={invitation.inviter.avatar}
                      alt={inviterName}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <span className="material-symbols-outlined">person</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#617289]">Invited to join as</p>
                  <p className="text-lg font-semibold text-[#111418]">{invitation.role}</p>
                </div>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleAccept} className="flex flex-col gap-5">
              {/* Email (readonly) */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-email">Email</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#9ca3af]">
                    <span className="material-symbols-outlined text-[20px]">mail</span>
                  </div>
                  <input
                    id="invite-email"
                    type="email"
                    value={invitation.email}
                    readOnly
                    className="block w-full rounded-lg border-[#dbe0e6] bg-gray-100 text-[#617289] pl-10 pr-3 py-3 text-sm cursor-not-allowed border"
                  />
                </div>
              </div>

              {/* Full Name */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-fullname">Full Name</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#9ca3af]">
                    <span className="material-symbols-outlined text-[20px]">person</span>
                  </div>
                  <input
                    id="invite-fullname"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="block w-full rounded-lg border border-[#dbe0e6] bg-white text-[#111418] pl-10 pr-3 py-3 text-sm placeholder:text-[#9ca3af] focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all shadow-sm"
                    placeholder="Your full name"
                    required
                  />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-password">Create Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#9ca3af]">
                    <span className="material-symbols-outlined text-[20px]">lock</span>
                  </div>
                  <input
                    id="invite-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="block w-full rounded-lg border border-[#dbe0e6] bg-white text-[#111418] pl-10 pr-10 py-3 text-sm placeholder:text-[#9ca3af] focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all shadow-sm"
                    placeholder="••••••••"
                    required
                    minLength={10}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-[#9ca3af] hover:text-[#617289] cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                <p className="text-xs text-[#617289] mt-1">
                  Min 10 characters with uppercase, lowercase, number, and special character
                </p>
              </div>

              {/* Confirm Password */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-[#111418]" htmlFor="invite-confirm-password">Confirm Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#9ca3af]">
                    <span className="material-symbols-outlined text-[20px]">lock</span>
                  </div>
                  <input
                    id="invite-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="block w-full rounded-lg border border-[#dbe0e6] bg-white text-[#111418] pl-10 pr-3 py-3 text-sm placeholder:text-[#9ca3af] focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-all shadow-sm"
                    placeholder="••••••••"
                    required
                    minLength={10}
                  />
                </div>
              </div>

              {/* Form Error */}
              {formError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-600">{formError}</p>
                </div>
              )}

              {/* Submit Button */}
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

            {/* Terms */}
            <p className="text-xs text-center text-[#617289] mt-6">
              By creating an account, you agree to our{" "}
              <Link href="/terms-of-service" className="text-primary hover:underline">Terms of Service</Link>
              {" "}and{" "}
              <Link href="/privacy-policy" className="text-primary hover:underline">Privacy Policy</Link>.
            </p>
          </div>
        )}

        {/* Success State */}
        {status === "accepted" && (
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-[#e5e7eb] p-8 sm:p-10 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-green-500 text-3xl">check_circle</span>
            </div>
            <h2 className="text-xl font-bold text-[#111418] mb-2">Welcome to the Team!</h2>
            <p className="text-[#617289] mb-6">Your account has been created successfully. You can now log in.</p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 px-6 py-3 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-colors"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-[18px]">login</span>
              Go to Login
            </Link>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#e5e7eb] py-6 bg-white">
        <div className="max-w-[1280px] mx-auto px-6 text-center text-sm text-[#617289]">
          &copy; 2026 Avise. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <span className="material-symbols-outlined text-3xl animate-spin text-primary">
            progress_activity
          </span>
        </div>
      }
    >
      <AcceptInviteContent />
    </Suspense>
  );
}
