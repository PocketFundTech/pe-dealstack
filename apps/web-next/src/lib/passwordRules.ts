// One password rule for signup, reset-password and accept-invite (the API's
// invitation accept route enforces the same rule). Error text names every
// requirement so users aren't told about only half of it.

export const PASSWORD_MIN_LENGTH = 10;

export const PASSWORD_RULE_TEXT =
  "At least 10 characters, with an uppercase letter, a lowercase letter, a number and a special character.";

/** Null when valid, otherwise a sentence naming what's missing. */
export function passwordError(password: string): string | null {
  const missing: string[] = [];
  if (!/[A-Z]/.test(password)) missing.push("an uppercase letter");
  if (!/[a-z]/.test(password)) missing.push("a lowercase letter");
  if (!/[0-9]/.test(password)) missing.push("a number");
  if (!/[^A-Za-z0-9]/.test(password)) missing.push("a special character");
  const tooShort = password.length < PASSWORD_MIN_LENGTH;
  if (!tooShort && missing.length === 0) return null;

  const parts: string[] = [];
  if (tooShort) parts.push(`be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (missing.length > 0) {
    const list =
      missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    parts.push(`include ${list}`);
  }
  return `Password must ${parts.join(" and ")}.`;
}
