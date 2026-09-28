"use client";

export function initials(nameOrEmail: string): string {
  const parts = nameOrEmail.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Initials avatar on the Banker Blue wash — used by dash-styled pages. */
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      title={name}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }}
      className="grid shrink-0 place-items-center rounded-full bg-(--dash-wash) font-bold text-(--dash-blue) ring-2 ring-(--dash-panel)"
    >
      {initials(name)}
    </span>
  );
}
