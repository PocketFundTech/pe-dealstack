// Data-loading hooks extracted from page.tsx so the page itself stays under
// the 500-line cap. Behavior is unchanged: same API calls, same error
// fallbacks, same useEffect timing as the inline implementation.

import { Dispatch, SetStateAction, useCallback, useEffect, useRef } from "react";
import { api, NotFoundError } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatters";
import { ChatMessage, DealOption, Memo, MemoSection, TemplateOption } from "./components";

interface UseLoadMemosArgs {
  statusFilter: string;
  setMemos: Dispatch<SetStateAction<Memo[]>>;
  setLoadingList: Dispatch<SetStateAction<boolean>>;
}

// Wraps the GET /memos call. Returns a memoized loader that the caller can
// trigger from useEffect (with the loader itself as a dep, matching the
// original implementation).
export function useLoadMemos({ statusFilter, setMemos, setLoadingList }: UseLoadMemosArgs) {
  return useCallback(async () => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      const data = await api.get<Memo[]>(`/memos${params.toString() ? "?" + params : ""}`);
      setMemos(Array.isArray(data) ? data : []);
    } catch (err) {
      // 404 means the endpoint isn't deployed yet — show empty state silently.
      // Other errors are also swallowed here; the page degrades to an empty list.
      if (!(err instanceof NotFoundError)) {
        // Non-404 errors are unexpected but we still fail gracefully.
      }
      setMemos([]);
    } finally {
      setLoadingList(false);
    }
  }, [statusFilter, setLoadingList, setMemos]);
}

interface UseLoadMemoArgs {
  setLoadingMemo: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedMemo: Dispatch<SetStateAction<Memo | null>>;
  setSections: Dispatch<SetStateAction<MemoSection[]>>;
  setEditingContent: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSection: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

// Loads a single memo by id, hydrates sections + chat conversation, and
// initialises the editing-content map. Mirrors the inline loadMemo from the
// original page.tsx.
export function useLoadMemo({
  setLoadingMemo,
  setError,
  setSelectedMemo,
  setSections,
  setEditingContent,
  setActiveSection,
  setMessages,
}: UseLoadMemoArgs) {
  return useCallback(async (id: string) => {
    setLoadingMemo(true);
    setError(null);
    try {
      const memo = await api.get<Memo & { sections?: MemoSection[]; conversations?: { messages?: ChatMessage[] }[] }>(`/memos/${id}`);
      setSelectedMemo(memo);

      const sortedSections = (memo.sections || [])
        .map((s) => ({
          ...s,
          hasTable: !!s.tableData,
          hasChart: !!s.chartConfig,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      setSections(sortedSections);

      // Initialize editing content
      const contentMap: Record<string, string> = {};
      sortedSections.forEach((s) => { contentMap[s.id] = s.content || ""; });
      setEditingContent(contentMap);

      setActiveSection(sortedSections[0]?.id || null);

      // Load chat messages
      if (memo.conversations?.length && memo.conversations[0].messages?.length) {
        setMessages(
          memo.conversations[0].messages.map((m) => ({
            id: m.id || String(Math.random()),
            role: m.role,
            content: m.content,
            timestamp: m.timestamp || formatRelativeTime(new Date().toISOString()),
          }))
        );
      } else {
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content: `Welcome to the Memo Builder. I can help you draft and refine sections for "${memo.projectName || memo.title}". Click the AI generate button on any section, or ask me a question below.`,
            timestamp: "Now",
          },
        ]);
      }
    } catch (err) {
      // 404: endpoint not yet deployed — clear selection and return to list.
      if (err instanceof NotFoundError) {
        setSelectedMemo(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load memo");
      }
    } finally {
      setLoadingMemo(false);
    }
  }, [setLoadingMemo, setError, setSelectedMemo, setSections, setEditingContent, setActiveSection, setMessages]);
}

interface UseOpenCreateModalArgs {
  setShowCreate: Dispatch<SetStateAction<boolean>>;
  setCreateForm: Dispatch<SetStateAction<{ dealId: string; templateId: string; title: string }>>;
  setDeals: Dispatch<SetStateAction<DealOption[]>>;
  setTemplates: Dispatch<SetStateAction<TemplateOption[]>>;
}

// Opens the Create Memo modal and lazy-fetches the deals + templates dropdown
// data. Normalises the dual response shape from /api/deals and /api/templates
// so a bare-array response works the same as a wrapped one.
export function useOpenCreateModal({ setShowCreate, setCreateForm, setDeals, setTemplates }: UseOpenCreateModalArgs) {
  return useCallback(async (prefillDealId?: string) => {
    setShowCreate(true);
    if (prefillDealId) {
      setCreateForm((f) => ({ ...f, dealId: prefillDealId }));
    }
    try {
      // /api/deals can return either a bare DealOption[] (current handler in
      // routes/deals.ts) OR { deals: DealOption[] } (other handlers in the
      // codebase). Normalise both shapes — same dual-shape pattern as
      // IngestDealForm.searchDeals — so the dropdown isn't empty when the
      // bare-array shape is returned.
      const [dealRes, templateRes] = await Promise.all([
        api.get<DealOption[] | { deals: DealOption[] }>("/deals?limit=50").catch(() => [] as DealOption[]),
        api.get<TemplateOption[] | { templates: TemplateOption[] }>("/templates").catch(() => [] as TemplateOption[]),
      ]);
      setDeals(Array.isArray(dealRes) ? dealRes : (dealRes?.deals ?? []));
      setTemplates(Array.isArray(templateRes) ? templateRes : (templateRes?.templates ?? []));
    } catch (err) {
      console.warn("[memo-builder] failed to load deals/templates for create modal:", err);
    }
  }, [setShowCreate, setCreateForm, setDeals, setTemplates]);
}

// ?dealId=X consumption hook. When the page is opened from a deal (e.g. the
// Memo Builder button on the deal analysis panel), receives ?dealId=X and
// either jumps straight into the deal's existing memo, or opens the Create
// modal pre-bound to that deal. Mirrors the legacy memo-builder.js
// dealId-branch behavior, but skips the multi-memo picker overlay since
// web-next already shows the full memo list in the left sidebar. Consumes
// once per distinct dealId so it doesn't re-trigger on every render.
//
// When ?fromChat=1 is present (deal-chat suggested-action redirect), skip
// the Create modal entirely: ask the API for an AI-suggested title +
// description and POST a new memo with autoGenerate=false (fast). Sections
// are written when the user clicks "Generate All" (AI on click only), as
// its own request — generating inside the create response routinely blew
// Vercel's 300s function budget.
export function useDealIdEffect(
  urlDealId: string | null,
  urlFromChat: string | null,
  loadMemo: (id: string) => Promise<void>,
  openCreateModal: (prefillDealId?: string) => Promise<void>,
  onAutoCreateStart?: () => void,
  onAutoCreateEnd?: () => void,
  onError?: (msg: string) => void,
) {
  const consumedDealIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!urlDealId) return;
    if (consumedDealIdRef.current === urlDealId) return;
    consumedDealIdRef.current = urlDealId;

    let cancelled = false;
    (async () => {
      // Chat-redirect path takes precedence over the existing-memo lookup:
      // every deal-chat "Create memo" click produces a fresh draft, even if
      // the deal already has memos. The chat agent (not the URL hook) is the
      // arbiter of when to start a new memo. Skipping the /memos lookup also
      // saves a DB round-trip on this hot path.
      if (urlFromChat === "1") {
        onAutoCreateStart?.();
        try {
          let title = "Investment Committee Memo";
          let description = "";
          try {
            const meta = await api.post<{ title?: string; description?: string }>(
              `/memos/suggest-meta`,
              { dealId: urlDealId },
            );
            if (meta?.title) title = meta.title;
            if (meta?.description) description = meta.description;
          } catch (metaErr) {
            console.warn("[memo-builder] suggest-meta failed; using default title:", metaErr);
          }
          if (cancelled) return;

          const created = await api.post<Memo>("/memos", {
            title,
            dealId: urlDealId,
            autoGenerate: false,
            type: "IC_MEMO",
            status: "DRAFT",
            metadata: description ? { description } : undefined,
          });
          if (cancelled) return;
          await loadMemo(created.id);
        } catch (err) {
          console.warn("[memo-builder] auto-create from chat failed:", err);
          onError?.(err instanceof Error ? err.message : "Failed to create memo from chat");
          // Fall back to the modal so the user can retry manually.
          if (!cancelled) openCreateModal(urlDealId);
        } finally {
          if (!cancelled) onAutoCreateEnd?.();
        }
        return;
      }

      // Non-chat path: prefer an existing memo for this deal; if none, open
      // the Create modal. Any throw falls through to the modal rather than
      // stranding the user on an empty state.
      let matches: Memo[] = [];
      try {
        const params = new URLSearchParams({ dealId: urlDealId });
        const result = await api.get<Memo[]>(`/memos?${params}`);
        if (Array.isArray(result)) matches = result;
      } catch (err) {
        console.warn("[memo-builder] dealId-prefill memo lookup failed:", err);
      }
      if (cancelled) return;

      if (matches.length > 0) {
        const best = [...matches].sort((a, b) =>
          (b.updatedAt || "").localeCompare(a.updatedAt || "")
        )[0];
        try {
          await loadMemo(best.id);
        } catch (err) {
          console.warn("[memo-builder] loadMemo failed, falling back to create:", err);
          if (!cancelled) openCreateModal(urlDealId);
        }
      } else {
        openCreateModal(urlDealId);
      }
    })();
    return () => { cancelled = true; };
  }, [urlDealId, urlFromChat, loadMemo, openCreateModal, onAutoCreateStart, onAutoCreateEnd, onError]);
}

// ?memoId=X — deep-link straight to a specific memo (used by Share button).
// Consume once per distinct memoId to avoid re-loading on every render.
export function useMemoIdEffect(urlMemoId: string | null, loadMemo: (id: string) => Promise<void>) {
  const consumedMemoIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!urlMemoId) return;
    if (consumedMemoIdRef.current === urlMemoId) return;
    consumedMemoIdRef.current = urlMemoId;
    loadMemo(urlMemoId);
  }, [urlMemoId, loadMemo]);
}
