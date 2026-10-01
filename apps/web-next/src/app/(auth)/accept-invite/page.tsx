"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Logo } from "@/components/layout/Logo";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { roleLabel } from "@/lib/roles";
import { CreateAccountForm, type InviteSession } from "./CreateAccountForm";
import { ExistingAccountJoin } from "./ExistingAccountJoin";

interface InviteData {
  email: string;
  firmName: string;
  organizationLogo: string | null;
  role: string;
  inviter: { name: string; avatar?: string } | null;
  accountExists: boolean;
}

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") || "";

  const [status, setStatus] = useState<"loading" | "valid" | "invalid" | "accepted">("loading");
  const [errorMessage, setErrorMessage] = useState("This invitation link is invalid or has expired.");
  const [invitation, setInvitation] = useState<InviteData | null>(null);
  // "signin" when the invited email already has an account (from /verify, or
  // a 409 ACCOUNT_EXISTS on create). Existing users join via /join/:token.
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [acceptedMessage, setAcceptedMessage] = useState("");
  const [redirecting, setRedirecting] = useState(false);

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
        accountExists: !!data.accountExists,
      });
      setMode(data.accountExists ? "signin" : "create");
      setStatus("valid");
    } catch (err) {
      console.warn("[auth/accept-invite] failed to verify invitation:", err);
      setErrorMessage("Unable to verify invitation. Please try again later.");
      setStatus("invalid");
    }
  }

  useEffect(() => {
    if (!token) {
      setErrorMessage("No invitation token provided. Please use the link from your invitation email.");
      setStatus("invalid");
      return;
    }
    verifyInvitation(token);
    // Is someone already signed in in this browser? Lets an existing user
    // join with one click (or tells them they're signed in as someone else).
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        const email = data.user?.email ?? null;
        setSessionEmail(email);
        if (email) setMode("signin");
      })
      .catch((err: unknown) => console.warn("[auth/accept-invite] session check failed:", err));
  }, [token]);

  // New account created. Apply the returned session and go straight to the
  // app; without one, say what to do instead of a dead-end "you can log in".
  async function handleCreated(session: InviteSession | null) {
    if (session?.access_token && session.refresh_token) {
      const { error } = await createClient().auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (!error) {
        setAcceptedMessage("Taking you to your workspace...");
        setRedirecting(true);
        setStatus("accepted");
        router.push("/dashboard");
        return;
      }
      console.warn("[auth/accept-invite] setSession failed:", error);
    }
    setAcceptedMessage("Your account is ready. Log in with your new password to continue.");
    setStatus("accepted");
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
                  <p className="text-lg font-semibold text-[#111418]">{roleLabel(invitation.role)}</p>
                </div>
              </div>
            </div>

            {mode === "create" ? (
              <CreateAccountForm
                token={token}
                email={invitation.email}
                onCreated={handleCreated}
                onAccountExists={() => setMode("signin")}
              />
            ) : (
              <ExistingAccountJoin
                token={token}
                email={invitation.email}
                firmName={invitation.firmName}
                sessionEmail={sessionEmail}
                onSignedOut={() => setSessionEmail(null)}
              />
            )}
          </div>
        )}

        {/* Success State */}
        {status === "accepted" && (
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-[#e5e7eb] p-8 sm:p-10 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-green-500 text-3xl">check_circle</span>
            </div>
            <h2 className="text-xl font-bold text-[#111418] mb-2">Welcome to the Team!</h2>
            <p className="text-[#617289] mb-6">{acceptedMessage}</p>
            {redirecting ? (
              <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full mx-auto" />
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center gap-2 px-6 py-3 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-colors"
                style={{ backgroundColor: "#003366" }}
              >
                <span className="material-symbols-outlined text-[18px]">login</span>
                Go to Login
              </Link>
            )}
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
