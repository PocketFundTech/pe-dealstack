"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/useApiQuery";
import type { Template } from "./types";
import { TemplateEditor } from "./TemplateEditor";
import { TemplatePreviewModal } from "./TemplatePreviewModal";
import { TemplateCard, CreateFromScratchCard } from "./TemplateCard";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TABS = [
  { key: "investment-memos", label: "Investment Memos", category: "INVESTMENT_MEMO" },
  { key: "diligence-checklists", label: "Diligence Checklists", category: "CHECKLIST" },
  { key: "outreach-sequences", label: "Outreach Sequences", category: "OUTREACH" },
] as const;

const TEMPLATE_TYPES = [
  { value: "investment-memo", label: "Investment Memo", category: "INVESTMENT_MEMO" },
  { value: "checklist", label: "Diligence Checklist", category: "CHECKLIST" },
  { value: "outreach", label: "Outreach Sequence", category: "OUTREACH" },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function TemplatesPage() {
  const router = useRouter();
  // Stale-while-revalidate cache: revisiting /templates renders instantly.
  const templatesQuery = useApiQuery<Template[]>("/templates");
  const templates = useMemo<Template[]>(
    () => (Array.isArray(templatesQuery.data) ? templatesQuery.data : []),
    [templatesQuery.data],
  );
  const loading = templatesQuery.isLoading;
  // Action errors (create/duplicate/delete) are layered on top of the query's
  // own load error so the banner can show either without the two competing.
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? (templatesQuery.error && templatesQuery.data === undefined ? templatesQuery.error.message || "Failed to load templates" : null);
  const [activeTab, setActiveTab] = useState<string>("investment-memos");
  const [search, setSearch] = useState("");

  /* Filter + Sort */
  const [showOnlyActive, setShowOnlyActive] = useState(false);
  const [sortByUsage, setSortByUsage] = useState(true);

  /* Selection */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* Modal state */
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "", category: "investment-memo" });
  const [creating, setCreating] = useState(false);

  /* Context menu */
  const [menuId, setMenuId] = useState<string | null>(null);

  /* Delete confirmation */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /* Preview modal */
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);

  /* Toast */
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error") => {
    setToast({ message, type });
  }, []);

  /* Auto-dismiss toast */
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ---- Refetch templates (revalidate the cache) ---- */
  const { refetch: refetchTemplates } = templatesQuery;
  const loadTemplates = useCallback(() => {
    setActionError(null);
    return refetchTemplates();
  }, [refetchTemplates]);

  /* ---- Filtered + sorted list ---- */
  const activeCategory = TABS.find((t) => t.key === activeTab)?.category || "INVESTMENT_MEMO";

  const visible = templates
    .filter((t) => t.category === activeCategory)
    .filter((t) => !showOnlyActive || t.isActive)
    .filter((t) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q);
    })
    .sort((a, b) =>
      sortByUsage
        ? (b.usageCount || 0) - (a.usageCount || 0)
        : new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

  /* Auto-select first visible template */
  const selectedTemplate = templates.find((t) => t.id === selectedId) || null;

  useEffect(() => {
    if (loading) return;
    if (visible.length > 0 && (!selectedId || !visible.some((t) => t.id === selectedId))) {
      setSelectedId(visible[0].id);
    } else if (visible.length === 0) {
      setSelectedId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, search, showOnlyActive, loading]);

  /* ---- Create ---- */
  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    setCreating(true);
    const categoryMap: Record<string, string> = {
      "investment-memo": "INVESTMENT_MEMO",
      checklist: "CHECKLIST",
      outreach: "OUTREACH",
    };
    try {
      const created = await api.post<Template>("/templates", {
        name: createForm.name.trim(),
        description: createForm.description.trim() || "New template",
        category: categoryMap[createForm.category] || "INVESTMENT_MEMO",
        isGoldStandard: false,
        isActive: true,
        permissions: "FIRM_WIDE",
      });
      templatesQuery.mutate((prev) => [created, ...(prev ?? [])]);
      setSelectedId(created.id);
      setShowCreate(false);
      setCreateForm({ name: "", description: "", category: "investment-memo" });
      showToast("Template created successfully", "success");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setCreating(false);
    }
  };

  /* ---- Duplicate ---- */
  const handleDuplicate = async (id: string) => {
    setMenuId(null);
    try {
      const dup = await api.post<Template>(`/templates/${id}/duplicate`, {});
      templatesQuery.mutate((prev) => [dup, ...(prev ?? [])]);
      setSelectedId(dup.id);
      showToast("Template duplicated", "success");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to duplicate template");
    }
  };

  /* ---- Delete ---- */
  const confirmDelete = (id: string) => {
    setMenuId(null);
    setDeleteTarget(id);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/templates/${deleteTarget}`);
      templatesQuery.mutate((prev) => (prev ?? []).filter((t) => t.id !== deleteTarget));
      if (selectedId === deleteTarget) setSelectedId(null);
      showToast("Template deleted", "success");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete template");
    }
    setDeleteTarget(null);
  };

  /* ---- Close menu on outside click ---- */
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuId]);

  /* ---- Editor callbacks ---- */
  const handleTemplateUpdate = useCallback(
    (updated: Template) => {
      templatesQuery.mutate((prev) => (prev ?? []).map((t) => (t.id === updated.id ? updated : t)));
    },
    [templatesQuery]
  );

  const handleEditorCancel = useCallback(() => {
    // Reload to revert changes
    loadTemplates();
  }, [loadTemplates]);

  const handleUseTemplate = useCallback(
    (template: Template) => {
      router.push(`/memo-builder?new=true&templateId=${template.id}`);
    },
    [router]
  );

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      {/* Left Panel: Template Library */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Page Title & Tabs */}
        <div className="px-8 pt-6 pb-4 shrink-0 bg-surface-card">
          <h1 className="text-2xl font-bold text-text-main tracking-tight mb-6">Firm-Wide Template Manager</h1>
          <div className="flex items-center justify-between border-b border-border-subtle">
            <div className="flex gap-8">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    "pb-3 border-b-2 font-medium text-sm px-1 transition-colors",
                    activeTab === tab.key
                      ? "border-primary text-primary font-semibold"
                      : "border-transparent text-text-muted hover:text-text-secondary"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 pb-2">
              <button
                onClick={() => setShowOnlyActive((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">filter_list</span>
                Filter: {showOnlyActive ? "Active" : "All"}
              </button>
              <button
                onClick={() => setSortByUsage((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">sort</span>
                Sort by Usage
              </button>
            </div>
          </div>
        </div>

        {/* Search bar integrated into page header area */}
        <div className="px-8 pt-4 pb-2 bg-background-body flex items-center justify-between">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[20px]">
              search
            </span>
            <input
              className="pl-9 pr-4 py-1.5 text-sm bg-background-body border border-border-subtle rounded-md w-64 focus:ring-1 focus:ring-primary focus:border-primary text-text-main placeholder-text-muted"
              placeholder="Search templates..."
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 text-white rounded-lg shadow-sm hover:opacity-90 transition-opacity text-sm font-medium"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            New Template
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-8 mt-2 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <span className="material-symbols-outlined text-[18px]">error</span>
            {error}
            <button onClick={() => setActionError(null)} className="ml-auto text-red-400 hover:text-red-600">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        {/* Grid Content */}
        <div className="flex-1 overflow-y-auto p-8 pt-6 bg-background-body custom-scrollbar">
          {loading ? (
            <div className="col-span-3 flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mb-4" />
              <p className="text-text-muted text-sm">Loading templates...</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-20">
              <div className="col-span-3 flex flex-col items-center justify-center py-14 text-center">
                <span className="material-symbols-outlined text-4xl text-text-muted mb-2">folder_open</span>
                <p className="text-sm font-medium text-text-main mb-1">No templates found</p>
                <p className="text-xs text-text-muted mb-4">
                  Try a different tab/filter or create a new template.
                </p>
              </div>
              {/* Create from Scratch card */}
              <CreateFromScratchCard onClick={() => setShowCreate(true)} />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-20">
              {visible.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isSelected={selectedId === template.id}
                  menuOpen={menuId === template.id}
                  onSelect={() => setSelectedId(template.id)}
                  onMenuToggle={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === template.id ? null : template.id);
                  }}
                  onDuplicate={() => handleDuplicate(template.id)}
                  onDelete={() => confirmDelete(template.id)}
                />
              ))}
              <CreateFromScratchCard onClick={() => setShowCreate(true)} />
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Template Editor */}
      {selectedTemplate && (
        <TemplateEditor
          template={selectedTemplate}
          onUpdate={handleTemplateUpdate}
          onPreview={() => setPreviewTemplate(selectedTemplate)}
          onUseTemplate={() => handleUseTemplate(selectedTemplate)}
          onCancel={handleEditorCancel}
          onToast={showToast}
        />
      )}

      {/* ---- Delete Confirmation Modal ---- */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-surface-card rounded-xl shadow-xl max-w-sm w-full mx-4 p-6">
            <h3 className="font-semibold text-text-main mb-2">Delete Template</h3>
            <p className="text-sm text-text-muted mb-4">
              Are you sure you want to delete &ldquo;
              {templates.find((t) => t.id === deleteTarget)?.name}
              &rdquo;? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm font-medium text-text-secondary bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 transition-colors"
                style={{ backgroundColor: "#dc2626" }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Create Template Modal ---- */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreate(false)} />
          <div className="relative bg-surface-card rounded-xl shadow-float w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-text-main">Create New Template</h2>
              <button onClick={() => setShowCreate(false)} className="p-1 hover:bg-background-body rounded-lg transition-colors">
                <span className="material-symbols-outlined text-text-muted">close</span>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-main mb-1">Template Name</label>
                <input
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-1 focus:ring-primary focus:border-primary"
                  placeholder="e.g., SaaS Growth Equity Memo"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1">Category</label>
                <select
                  value={createForm.category}
                  onChange={(e) => setCreateForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-1 focus:ring-primary focus:border-primary"
                >
                  {TEMPLATE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1">Description</label>
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-1 focus:ring-primary focus:border-primary resize-none"
                  rows={3}
                  placeholder="Brief description of when to use this template..."
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-main transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!createForm.name.trim() || creating}
                className="px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "#003366" }}
              >
                {creating ? "Creating..." : "Create Template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Preview Modal ---- */}
      {previewTemplate && (
        <TemplatePreviewModal
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onUseTemplate={() => {
            setPreviewTemplate(null);
            handleUseTemplate(previewTemplate);
          }}
        />
      )}

      {/* ---- Toast ---- */}
      {toast && (
        <div
          className={cn(
            "fixed top-4 right-4 z-[60] flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all border",
            toast.type === "success"
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200"
          )}
        >
          <span className="material-symbols-outlined text-[18px]">
            {toast.type === "success" ? "check_circle" : "error"}
          </span>
          {toast.message}
        </div>
      )}
    </div>
  );
}
