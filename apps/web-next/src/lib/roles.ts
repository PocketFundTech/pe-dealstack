// One role-label map for the whole app. The API stores ADMIN / MEMBER /
// VIEWER (apps/api/src/routes/invitations.ts); people see these labels
// everywhere — invite dialog, onboarding team task, team list, accept-invite.
// Before this, onboarding offered "Analyst/VP/Partner/Admin" that were never
// sent, the invite dialog said "Associate", and the team list showed "MEMBER".

export type ApiRole = "ADMIN" | "MEMBER" | "VIEWER";

export const ROLE_OPTIONS: { value: ApiRole; label: string; description: string }[] = [
  { value: "VIEWER", label: "Analyst", description: "View-only access" },
  { value: "MEMBER", label: "Associate", description: "Can edit deals" },
  { value: "ADMIN", label: "Admin", description: "Full access" },
];

export const DEFAULT_INVITE_ROLE: ApiRole = "MEMBER";

const LABELS: Record<string, string> = Object.fromEntries(
  ROLE_OPTIONS.map((r) => [r.value, r.label]),
);

/** Human label for an API role; unknown values are title-cased, never shown raw. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  const known = LABELS[role.toUpperCase()];
  if (known) return known;
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}
