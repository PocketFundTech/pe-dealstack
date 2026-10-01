"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/authErrors";

// Shown under "Please verify your email" on login: resend the verification
// email or go type the 6-digit code, instead of leaving the user stuck.
export function UnconfirmedEmailHelp({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  const resend = async () => {
    setState("sending");
    setError("");
    const { error: resendError } = await createClient().auth.resend({ type: "signup", email: email.trim() });
    if (resendError) {
      setError(friendlyAuthError(resendError.message));
      setState("idle");
      return;
    }
    setState("sent");
  };

  return (
    <div className="mt-2 flex flex-col items-center gap-1 text-slate-700">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={resend}
          disabled={state !== "idle"}
          className="font-semibold text-primary hover:underline disabled:opacity-60 disabled:no-underline"
        >
          {state === "sending" ? "Sending..." : state === "sent" ? "Verification email sent" : "Resend verification email"}
        </button>
        <Link
          href={`/verify-email?email=${encodeURIComponent(email.trim())}`}
          className="font-semibold text-primary hover:underline"
        >
          Enter code
        </Link>
      </div>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
