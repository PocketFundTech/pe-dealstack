"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/authErrors";

const RESEND_COOLDOWN_SECONDS = 60;

/** /verify-email with the address prefilled for the 6-digit code form. */
export function verifyEmailHref(email: string): string {
  return `/verify-email?email=${encodeURIComponent(email)}`;
}

// "Check your email" state after a signup that needs confirmation. Gives the
// user a way forward when the email is slow or lost: resend it (with a
// cooldown) or type the 6-digit code instead.
export function CheckEmailPanel({ email }: { email: string }) {
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const resend = async () => {
    setSending(true);
    setMessage(null);
    const { error } = await createClient().auth.resend({ type: "signup", email });
    setSending(false);
    if (error) {
      setMessage({ type: "error", text: friendlyAuthError(error.message) });
      return;
    }
    setMessage({ type: "success", text: "Sent again — check your inbox and spam folder." });
    setCooldown(RESEND_COOLDOWN_SECONDS);
  };

  return (
    <div className="text-[13px] bg-secondary-light p-4 rounded-lg text-center space-y-3">
      <p className="text-secondary">
        Check <strong>{email}</strong> for a verification link, then come back to log in.
      </p>
      <div className="flex items-center justify-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={resend}
          disabled={sending || cooldown > 0}
          className="font-semibold text-primary hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {sending ? "Sending..." : cooldown > 0 ? `Resend email (${cooldown}s)` : "Resend email"}
        </button>
        <Link href={verifyEmailHref(email)} className="font-semibold text-primary hover:underline">
          Enter code instead
        </Link>
      </div>
      {message && (
        <p className={message.type === "success" ? "text-green-700" : "text-red-600"}>{message.text}</p>
      )}
    </div>
  );
}
