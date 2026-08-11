"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

export interface PasteKeyInstructions {
  title: string;
  body: string;
  helpUrl?: string;
  placeholder?: string;
}

interface Props {
  provider: string;
  instructions: PasteKeyInstructions;
  onClose: () => void;
  onConnected: () => void;
}

export function PasteKeyModal({ provider, instructions, onClose, onConnected }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function submit() {
    const key = apiKey.trim();
    setError(null);
    if (key.length < 8) {
      setError("That key looks too short.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/integrations/${provider}/api-key`, { apiKey: key });
      onConnected();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not connect.";
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
        <h3 className="text-base font-bold text-text-main mb-1">{instructions.title}</h3>
        <p className="text-sm text-text-secondary mb-3 whitespace-pre-line">
          {instructions.body}
        </p>
        {instructions.helpUrl && (
          <a
            href={instructions.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold inline-block mb-3"
            style={{ color: "#003366" }}
          >
            How to find your key →
          </a>
        )}
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={instructions.placeholder ?? ""}
          disabled={submitting}
          className="mt-1 w-full border border-border-subtle rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 disabled:opacity-50"
          style={{ ["--tw-ring-color" as string]: "#00336666" } as React.CSSProperties}
        />
        {error && (
          <div className="mt-2 text-xs text-red-700">{error}</div>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm font-semibold rounded-md border border-border-subtle bg-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm font-semibold rounded-md text-white disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
