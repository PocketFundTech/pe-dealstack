"use client";

// Small pieces of the HubSpot panel, kept out of IntegrationsSection.tsx
// (already over the 500-line guideline).

/** Scopes the HubSpot Private App needs. Owners/files are optional but recommended. */
export const HUBSPOT_REQUIRED_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read",
  "crm.objects.notes.read",
  "crm.objects.calls.read",
  "crm.objects.meetings.read",
  "crm.objects.emails.read",
  "crm.objects.tasks.read",
  "crm.objects.owners.read",
  "files",
  "files.ui_hidden.read",
] as const;

export function HubSpotScopeHelp() {
  return (
    <p className="mt-1 text-xs text-text-muted">
      HubSpot → Settings → Integrations → Private Apps. Under Scopes, grant{" "}
      {HUBSPOT_REQUIRED_SCOPES.map((s, i) => (
        <span key={s}>
          <code className="text-xs bg-gray-100 px-1 rounded">{s}</code>
          {i < HUBSPOT_REQUIRED_SCOPES.length - 1 ? ", " : ""}
        </span>
      ))}
      , plus the matching <code className="text-xs bg-gray-100 px-1 rounded">crm.schemas.*</code> scopes for
      companies, contacts and deals (needed to import your custom fields). The owners scope fills in Lead Partners;
      the two file scopes bring over files attached to deals.
    </p>
  );
}

export function HubSpotStatusError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm" role="alert">
      <p className="font-semibold text-red-800">Couldn&apos;t check your HubSpot connection.</p>
      <p className="mt-0.5 text-red-700">
        {message || "The server didn't answer."} Your connection and imports are unchanged — this only affects what
        this page can show.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-800 hover:bg-red-100"
      >
        Retry
      </button>
    </div>
  );
}
