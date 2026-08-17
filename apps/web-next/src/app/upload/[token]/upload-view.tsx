"use client";

// Presentational half of the public document-upload page. Split from
// page.tsx the same way portal-view.tsx is split from portal/[token] —
// keeps the data-fetching shell thin and the view unit-testable.
//
// Audience is a broker or business owner on a phone who has never heard of
// this product and has no account. Everything here optimises for that: big
// tap targets, no jargon, no login, per-item feedback, and an explicit
// "I'm done" so they know the hand-off completed.

import { useCallback, useMemo, useRef, useState } from "react";

export interface UploadItem {
  id: string;
  label: string;
  notes: string | null;
  required: boolean;
  fulfilled: boolean;
}

export interface UploadPayload {
  dealName: string;
  companyName: string | null;
  firmName: string;
  recipientName: string | null;
  message: string | null;
  status: string;
  items: UploadItem[];
}

export type UploadState =
  | { status: "loading" }
  | { status: "notfound" }
  | { status: "gone"; message: string }
  | { status: "ready"; payload: UploadPayload };

type ItemState = "idle" | "uploading" | "done" | "error";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F9FA] px-4 py-10">
      <div className="mx-auto w-full max-w-[640px]">{children}</div>
    </div>
  );
}

function Notice({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <Shell>
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
        <span className="material-symbols-outlined text-4xl text-gray-400">{icon}</span>
        <h1 className="mt-3 text-lg font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-500">{body}</p>
      </div>
    </Shell>
  );
}

export function UploadView({ state, token }: { state: UploadState; token: string }) {
  const [items, setItems] = useState<UploadItem[] | null>(null);
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Locally-updated list once an upload lands, otherwise whatever the server
  // sent. Memoised so uploadFile's identity is stable across renders.
  const serverItems = state.status === "ready" ? state.payload.items : null;
  const rows = useMemo(() => items ?? serverItems ?? [], [items, serverItems]);

  const uploadFile = useCallback(
    async (itemId: string, file: File) => {
      setItemStates((s) => ({ ...s, [itemId]: "uploading" }));
      setErrors((e) => {
        const next = { ...e };
        delete next[itemId];
        return next;
      });

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/public/doc-requests/${token}/items/${itemId}/upload`, {
          method: "POST",
          body: form,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setItemStates((s) => ({ ...s, [itemId]: "error" }));
          setErrors((e) => ({
            ...e,
            [itemId]: body.error || "That upload didn't go through. Please try again.",
          }));
          return;
        }

        setItemStates((s) => ({ ...s, [itemId]: "done" }));
        setItems((current) =>
          (current ?? rows).map((i) => (i.id === itemId ? { ...i, fulfilled: true } : i)),
        );
      } catch (err) {
        console.warn("doc request upload failed", err);
        setItemStates((s) => ({ ...s, [itemId]: "error" }));
        setErrors((e) => ({ ...e, [itemId]: "Network problem — please try again." }));
      }
    },
    [rows, token],
  );

  const markComplete = useCallback(async () => {
    try {
      await fetch(`/api/public/doc-requests/${token}/complete`, { method: "POST" });
    } catch (err) {
      // The files are already delivered — completion is a courtesy signal,
      // so a failure here must not scare the uploader.
      console.warn("doc request complete failed", err);
    }
    setCompleted(true);
  }, [token]);

  if (state.status === "loading") {
    return (
      <Shell>
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <span className="material-symbols-outlined animate-spin text-3xl text-gray-400">
            progress_activity
          </span>
        </div>
      </Shell>
    );
  }

  if (state.status === "notfound") {
    return (
      <Notice
        icon="link_off"
        title="This link isn't valid"
        body="Double-check the link in your email, or ask the person who sent it for a new one."
      />
    );
  }

  if (state.status === "gone") {
    return <Notice icon="lock_clock" title="This link is no longer active" body={state.message} />;
  }

  const { payload } = state;
  const outstanding = rows.filter((i) => !i.fulfilled);
  const receivedCount = rows.length - outstanding.length;

  if (completed) {
    return (
      <Notice
        icon="task_alt"
        title="Thank you — all sent"
        body={`${payload.firmName} has been notified. You can close this page.`}
      />
    );
  }

  return (
    <Shell>
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-5">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Document request
          </p>
          <h1 className="mt-1 text-xl font-semibold text-gray-900">
            {payload.companyName || payload.dealName}
          </h1>
          <p className="mt-1 text-sm text-gray-500">Requested by {payload.firmName}</p>
        </div>

        {payload.message && (
          <div className="mx-6 mt-5 rounded-lg border-l-[3px] border-[#003366] bg-[#F8F9FA] px-4 py-3">
            <p className="text-sm text-gray-700">{payload.message}</p>
          </div>
        )}

        <div className="px-6 py-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">
              {receivedCount} of {rows.length} received
            </h2>
            <span className="text-xs text-gray-500">No account needed</span>
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((item) => {
              const itemState = itemStates[item.id] ?? (item.fulfilled ? "done" : "idle");
              const isDone = item.fulfilled || itemState === "done";
              return (
                <li
                  key={item.id}
                  className="rounded-lg border border-gray-200 px-4 py-3 transition-colors"
                  style={isDone ? { backgroundColor: "#F0FDF4", borderColor: "#BBF7D0" } : undefined}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {item.label}
                        {!item.required && (
                          <span className="ml-1.5 text-xs font-normal text-gray-400">optional</span>
                        )}
                      </p>
                      {item.notes && <p className="mt-0.5 text-xs text-gray-500">{item.notes}</p>}
                      {errors[item.id] && (
                        <p className="mt-1 text-xs text-red-600">{errors[item.id]}</p>
                      )}
                    </div>

                    {isDone ? (
                      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-green-700">
                        <span className="material-symbols-outlined text-[18px]">check_circle</span>
                        Received
                      </span>
                    ) : (
                      <>
                        <input
                          ref={(el) => {
                            inputRefs.current[item.id] = el;
                          }}
                          type="file"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadFile(item.id, file);
                            e.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => inputRefs.current[item.id]?.click()}
                          disabled={itemState === "uploading"}
                          className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
                          style={{ backgroundColor: "#003366" }}
                        >
                          {itemState === "uploading" ? "Uploading…" : "Choose file"}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => void markComplete()}
            className="mt-6 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            {outstanding.length > 0 ? "I've sent everything I have" : "Done"}
          </button>
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-gray-400">
        This link is private to you — please don&rsquo;t forward it.
      </p>
    </Shell>
  );
}
