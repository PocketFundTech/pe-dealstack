"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import type { Template, TemplateSection } from "./types";
import { SectionList } from "./SectionList";
import { AddSectionModal } from "./AddSectionModal";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TemplateEditorProps {
  template: Template;
  onUpdate: (updated: Template) => void;
  onPreview: () => void;
  onUseTemplate: () => void;
  onCancel: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CATEGORY_OPTIONS = [
  { value: "INVESTMENT_MEMO", label: "Investment Memo" },
  { value: "CHECKLIST", label: "Checklist" },
  { value: "OUTREACH", label: "Email Sequence" },
];

const PERMISSION_OPTIONS = [
  { value: "FIRM_WIDE", label: "Firm-Wide (All)" },
  { value: "PARTNERS_ONLY", label: "Partners Only" },
  { value: "ANALYSTS_ONLY", label: "Analysts Only" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TemplateEditor({
  template,
  onUpdate,
  onPreview,
  onUseTemplate,
  onCancel,
  onToast,
}: TemplateEditorProps) {
  const [name, setName] = useState(template.name);
  const [category, setCategory] = useState(template.category);
  const [permissions, setPermissions] = useState(template.permissions);
  const [isActive, setIsActive] = useState(template.isActive);
  const [sections, setSections] = useState<TemplateSection[]>(
    [...(template.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder)
  );
  const [showAddSection, setShowAddSection] = useState(false);
  const [saving, setSaving] = useState(false);
  const isDirty = name !== template.name || category !== template.category || permissions !== template.permissions;
  useUnsavedChanges(isDirty);

  /* Sync local state when template prop changes */
  const templateId = template.id;
  const [prevId, setPrevId] = useState(templateId);
  if (templateId !== prevId) {
    setPrevId(templateId);
    setName(template.name);
    setCategory(template.category);
    setPermissions(template.permissions);
    setIsActive(template.isActive);
    setSections([...(template.sections || [])].sort((a, b) => a.sortOrder - b.sortOrder));
  }

  /* ---- Toggle active ---- */
  const handleToggleActive = useCallback(async () => {
    const newVal = !isActive;
    setIsActive(newVal);
    try {
      await api.patch(`/templates/${template.id}`, { isActive: newVal });
      onUpdate({ ...template, isActive: newVal });
    } catch (err) {
      console.warn("[templates] failed to toggle active state:", err);
      setIsActive(!newVal);
      onToast("Failed to toggle active state", "error");
    }
  }, [isActive, template, onUpdate, onToast]);

  /* ---- Save changes ---- */
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      onToast("Template name cannot be empty", "error");
      return;
    }
    setSaving(true);
    const updateData = { name: name.trim(), category, permissions };
    try {
      const updated = await api.patch<Template>(`/templates/${template.id}`, updateData);
      onUpdate({ ...template, ...updated, sections });
      onToast("Template saved successfully", "success");
    } catch (err) {
      console.warn("[templates] failed to save template:", err);
      onToast("Failed to save template", "error");
    } finally {
      setSaving(false);
    }
  }, [name, category, permissions, template, sections, onUpdate, onToast]);

  /* ---- Section CRUD ---- */
  const handleAddSection = useCallback(
    async (sectionData: { title: string; description: string; aiEnabled: boolean; mandatory: boolean }) => {
      const maxSort = Math.max(...sections.map((s) => s.sortOrder), -1);
      const payload = { ...sectionData, aiPrompt: "", sortOrder: maxSort + 1 };
      try {
        const created = await api.post<TemplateSection>(`/templates/${template.id}/sections`, payload);
        const newSections = [...sections, created].sort((a, b) => a.sortOrder - b.sortOrder);
        setSections(newSections);
        onUpdate({ ...template, sections: newSections });
        onToast("Section added", "success");
        setShowAddSection(false);
      } catch (err) {
        console.warn("[templates] failed to add section:", err);
        onToast("Failed to add section", "error");
      }
    },
    [sections, template, onUpdate, onToast]
  );

  const handleUpdateSection = useCallback(
    async (sectionId: string, data: Partial<TemplateSection>) => {
      try {
        await api.patch(`/templates/${template.id}/sections/${sectionId}`, data);
        const newSections = sections.map((s) => (s.id === sectionId ? { ...s, ...data } : s));
        setSections(newSections);
        onUpdate({ ...template, sections: newSections });
        onToast("Section updated", "success");
      } catch (err) {
        console.warn("[templates] failed to update section:", err);
        onToast("Failed to update section", "error");
      }
    },
    [sections, template, onUpdate, onToast]
  );

  const handleDeleteSection = useCallback(
    async (sectionId: string) => {
      try {
        await api.delete(`/templates/${template.id}/sections/${sectionId}`);
        const newSections = sections.filter((s) => s.id !== sectionId);
        setSections(newSections);
        onUpdate({ ...template, sections: newSections });
        onToast("Section deleted", "success");
      } catch (err) {
        console.warn("[templates] failed to delete section:", err);
        onToast("Failed to delete section", "error");
      }
    },
    [sections, template, onUpdate, onToast]
  );

  const handleReorderSections = useCallback(
    async (reordered: TemplateSection[]) => {
      const updated = reordered.map((s, i) => ({ ...s, sortOrder: i }));
      setSections(updated);
      onUpdate({ ...template, sections: updated });
      try {
        await api.post(`/templates/${template.id}/sections/reorder`, {
          sections: updated.map((s, i) => ({ id: s.id, sortOrder: i })),
        });
        onToast("Sections reordered", "success");
      } catch (err) {
        console.warn("[templates] failed to reorder sections:", err);
        onToast("Failed to reorder sections", "error");
      }
    },
    [template, onUpdate, onToast]
  );

  return (
    <div className="w-[480px] bg-surface-card border-l border-border-subtle flex flex-col shadow-float shrink-0">
      {/* Drawer Header */}
      <div className="px-6 py-5 border-b border-border-subtle flex items-start justify-between bg-background-body/50">
        <div className="flex-1 mr-4">
          <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
            Template Name
          </label>
          <input
            className="w-full bg-transparent border-none p-0 text-lg font-bold text-text-main focus:ring-0 focus:outline-none placeholder-text-muted"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted font-medium">Active</span>
            <button
              onClick={handleToggleActive}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full cursor-pointer transition-colors",
                isActive ? "bg-secondary" : "bg-border-subtle"
              )}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition shadow-sm",
                  isActive ? "translate-x-5" : "translate-x-1"
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Drawer Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
        {/* Section List */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-text-main uppercase tracking-wide">Document Structure</h3>
            <button
              onClick={() => setShowAddSection(true)}
              className="text-xs font-medium hover:underline flex items-center gap-1"
              style={{ color: "#003366" }}
            >
              <span className="material-symbols-outlined text-[14px]">add</span> Add Section
            </button>
          </div>
          <SectionList
            sections={sections}
            onUpdate={handleUpdateSection}
            onDelete={handleDeleteSection}
            onReorder={handleReorderSections}
          />
        </div>

        {/* Template Settings */}
        <div className="pt-6 border-t border-border-subtle">
          <h3 className="text-sm font-bold text-text-main uppercase tracking-wide mb-4">Template Settings</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full text-sm border-border-subtle rounded-md shadow-sm focus:border-primary focus:ring-primary bg-surface-card text-text-main py-1.5"
              >
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Permissions</label>
              <select
                value={permissions}
                onChange={(e) => setPermissions(e.target.value)}
                className="w-full text-sm border-border-subtle rounded-md shadow-sm focus:border-primary focus:ring-primary bg-surface-card text-text-main py-1.5"
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Drawer Footer */}
      <div className="p-4 border-t border-border-subtle bg-background-body/50 flex items-center justify-between gap-4">
        <div className="flex gap-2">
          <button
            onClick={onPreview}
            className="px-4 py-2 border border-border-subtle rounded-lg text-sm font-medium text-text-secondary hover:bg-background-body transition-colors"
          >
            Preview
          </button>
          <button
            onClick={onUseTemplate}
            className="px-4 py-2 bg-secondary hover:bg-secondary/90 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">play_arrow</span>
            Use Template
          </button>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-muted hover:text-text-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 text-white rounded-lg text-sm font-bold shadow-sm transition-colors flex items-center gap-2 hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Add Section Modal */}
      {showAddSection && (
        <AddSectionModal
          onAdd={handleAddSection}
          onClose={() => setShowAddSection(false)}
        />
      )}
    </div>
  );
}
