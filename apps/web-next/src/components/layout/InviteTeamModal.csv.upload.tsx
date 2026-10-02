"use client";

import { useRef, useState } from "react";
import { MAX_BULK_ROWS } from "./InviteTeamModal.csv.parse";

// Upload step UI for the BulkCsvImportPanel — drag-drop zone + format reference.
// Extracted from InviteTeamModal.csv.tsx so the parent module stays under the
// 500-line cap.

export function CsvUploadStep({
  topError,
  onFile,
}: {
  topError: string | null;
  onFile: (file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div className="space-y-4">
      {/* Format reference */}
      <div className="bg-[#F0F4F8] border border-[#E0E8F0] rounded-lg p-4">
        <div className="flex gap-3 items-start">
          <span className="material-symbols-outlined text-[#003366] text-xl mt-0.5">
            description
          </span>
          <div className="flex-1 text-sm text-[#343A40]">
            <div className="font-medium mb-1">Expected CSV format</div>
            <div className="text-[#868E96] text-xs mb-2">
              Headers required: <code>email</code> (required),{" "}
              <code>role</code> (optional, defaults to Analyst),{" "}
              <code>deal</code> (optional). Roles: Analyst, Associate, Admin.
            </div>
            <pre className="bg-white border border-[#EBEBEB] rounded-md p-2 text-xs text-[#343A40] overflow-x-auto whitespace-pre">{`email,role,deal
analyst1@firm.com,ANALYST,
partner@firm.com,ASSOCIATE,Project Atlas`}</pre>
            <div className="text-[#868E96] text-xs mt-2">
              Up to {MAX_BULK_ROWS} people per import. Deal names are matched to
              your deals (you can change them in the next step); each person is
              added to that deal&apos;s team when they join.
            </div>
          </div>
        </div>
      </div>

      {/* Drop zone */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={`block border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragging
            ? "border-[#003366] bg-[#E6EDF5]"
            : "border-[#EBEBEB] bg-white hover:border-[#003366]/40 hover:bg-[#F0F4F8]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <span className="material-symbols-outlined text-4xl text-[#003366]">
          upload_file
        </span>
        <div className="mt-2 text-sm font-medium text-[#343A40]">
          Drop your CSV here, or click to browse
        </div>
        <div className="text-xs text-[#868E96] mt-1">.csv files only</div>
      </label>

      {topError && (
        <div className="rounded-lg p-3 text-sm border bg-red-50 border-red-200 text-red-700">
          {topError}
        </div>
      )}
    </div>
  );
}
