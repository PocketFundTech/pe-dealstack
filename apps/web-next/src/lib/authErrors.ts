import { PASSWORD_RULE_TEXT } from "./passwordRules";

// Supabase auth returns developer-facing messages ("Invalid login
// credentials", "For security purposes, you can only request this after 41
// seconds", "AuthRetryableFetchError"…). Map the common ones to plain text
// for every auth page; anything unknown passes through unchanged.

export const EMAIL_NOT_CONFIRMED = "Please verify your email address before signing in.";

export function isEmailNotConfirmed(raw: string | null | undefined): boolean {
  return /email not confirmed/i.test(raw ?? "");
}

export function friendlyAuthError(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "Something went wrong. Please try again.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password. Please try again.";
  if (isEmailNotConfirmed(msg)) return EMAIL_NOT_CONFIRMED;
  if (/already (been )?registered|user already exists/i.test(msg)) {
    return "An account with this email already exists — log in or reset your password.";
  }
  const wait = msg.match(/after (\d+) seconds?/i);
  if (wait) return `Too many attempts. Please wait ${wait[1]} seconds and try again.`;
  if (/rate limit|too many requests/i.test(msg)) {
    return "Too many attempts. Please wait a few minutes and try again.";
  }
  if (/token has expired|otp.*(expired|invalid)|invalid.*otp/i.test(msg)) {
    return "This code or link has expired or is invalid. Request a new one.";
  }
  if (/password should|password is too weak|weak password/i.test(msg)) return PASSWORD_RULE_TEXT;
  if (/same as the old password|different from the old password/i.test(msg)) {
    return "New password must be different from your old password.";
  }
  if (/failed to fetch|network|fetcherror/i.test(msg)) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (/signups not allowed|signup is disabled/i.test(msg)) {
    return "New sign-ups are currently closed. Contact us for access.";
  }
  return msg;
}
