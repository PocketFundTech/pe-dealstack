"use client";

// The dashed "entry" tiles that start each creation/import flow from the NDA
// gallery grid. Split out of Gallery.tsx to keep that file under the 500-line
// cap. All three share the same dashed-button shell (EntryTile); only the
// icon + copy differ.

interface EntryTileProps {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}

// Shared shell: a dashed card with a circular icon, a title, and a one-line
// hint. Banker-blue hover accents match the rest of the page.
function EntryTile({ icon, title, subtitle, onClick }: EntryTileProps) {
  return (
    <button
      onClick={onClick}
      className="group relative aspect-[4/3] rounded-xl border-2 border-dashed border-slate-300 bg-slate-50/40 hover:border-[#003366] hover:bg-[#E6EEF5]/60 transition flex items-center justify-center"
    >
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-6 rounded-lg border-2 border-dashed border-slate-300 group-hover:border-[#003366] transition">
        <div className="w-11 h-11 rounded-full bg-white border border-slate-200 group-hover:border-[#003366] flex items-center justify-center text-slate-500 group-hover:text-[#003366] shadow-sm">
          <span className="material-symbols-outlined text-[24px]">{icon}</span>
        </div>
        <div className="text-sm font-medium text-slate-700 group-hover:text-[#003366]">
          {title}
        </div>
        <div className="text-[11px] text-slate-400 -mt-1.5 px-4 text-center leading-snug">
          {subtitle}
        </div>
      </div>
    </button>
  );
}

export function CreateTile({ onClick }: { onClick: () => void }) {
  return (
    <EntryTile
      icon="add"
      title="New NDA"
      subtitle="Draft a fresh NDA from one of your verified templates"
      onClick={onClick}
    />
  );
}

export function UploadExistingTile({
  status,
  onClick,
}: {
  status: "SENT" | "SIGNED";
  onClick: () => void;
}) {
  const verb = status === "SENT" ? "sent" : "signed";
  return (
    <EntryTile
      icon="upload_file"
      title="Upload Existing NDA"
      subtitle={`Import an NDA already ${verb} outside this app`}
      onClick={onClick}
    />
  );
}

// Companion to UploadExistingTile: starts the "bring your own Google Doc"
// import. Distinct CTA because the mechanic differs — the user pastes a Drive
// URL rather than uploading a file, and the Doc stays the source of truth.
export function ImportGdocTile({ onClick }: { onClick: () => void }) {
  return (
    <EntryTile
      icon="link"
      title="Import from Google Docs"
      subtitle="Paste a Doc URL — add an eSignature in Google, then send"
      onClick={onClick}
    />
  );
}
