"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { friendlyAuthError } from "@/lib/authErrors";

// Existing-account path: sign in (if needed) as the invited email, then
// POST /public/invitations/join/:token, which attaches the signed-in user to
// the inviting org. The server re-checks that the signed-in email matches.
export function ExistingAccountJoin({
  token,
  email,
  firmName,
  sessionEmail,
  onSignedOut,
}: {
  token: string;
  email: string;
  firmName: string;
  /** Email of the browser's current session, if any. */
  sessionEmail: string | null;
  onSignedOut: () => void;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const signedInAsInvitee = !!sessionEmail && sessionEmail.toLowerCase() === email.toLowerCase();
  const signedInAsOther = !!sessionEmail && !signedInAsInvitee;

  const join = async () => {
    await api.post(`/public/invitations/join/${token}`, {});
    router.push("/dashboard");
  };

  const handleJoin = async () => {
    setError("");
    setBusy(true);
    try {
      await join();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join the workspace");
      setBusy(false);
    }
  };

  const handleSignInAndJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!password) {
      setError("Enter your password");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(friendlyAuthError(signInError.message));
      setBusy(false);
      return;
    }
    try {
      await join();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join the workspace");
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    onSignedOut();
  };

  const primaryBtn =
    "w-full py-3 px-4 rounded-lg text-white text-sm font-semibold hover:opacity-90 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-60";

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-[#111418]">
        You already have an Avise account for <strong>{email}</strong>. Sign in to accept the invitation.
      </div>

      {signedInAsInvitee && (
        <button type="button" onClick={handleJoin} disabled={busy} className={primaryBtn} style={{ backgroundColor: "#003366" }}>
          {busy ? "Joining..." : `Join ${firmName}`}
        </button>
      )}

      {signedInAsOther && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          You&apos;re signed in as {sessionEmail}, but this invitation is for {email}.{" "}
          <button type="button" onClick={handleSignOut} className="font-semibold underline">
            Sign out
          </button>{" "}
          to continue.
        </div>
      )}

      {!sessionEmail && (
        <form onSubmit={handleSignInAndJoin} className="flex flex-col gap-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-[#111418]" htmlFor="join-email">Email</label>
            <input
              id="join-email"
              type="email"
              value={email}
              readOnly
              className="block w-full rounded-lg border border-[#dbe0e6] bg-gray-100 text-[#617289] px-3 py-3 text-sm cursor-not-allowed"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-[#111418]" htmlFor="join-password">Password</label>
              <Link href="/forgot-password" className="text-xs font-semibold text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
            <input
              id="join-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="block w-full rounded-lg border border-[#dbe0e6] bg-white px-3 py-3 text-sm focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </div>
          <button type="submit" disabled={busy} className={primaryBtn} style={{ backgroundColor: "#003366" }}>
            {busy ? "Signing in..." : "Sign in & join"}
          </button>
        </form>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}
    </div>
  );
}
