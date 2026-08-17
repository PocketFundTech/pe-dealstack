// Section-action handlers extracted from page.tsx so the page itself fits
// under the 500-line cap. Each function is a factory that closes over the
// dependencies it needs (selectedMemo, state setters, etc) and returns the
// async handler. Behavior is unchanged — same call signatures, same API
// payloads, same side effects.

import { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { Memo, MemoSection, SECTION_TYPES } from "./components";

interface SectionDeps {
  selectedMemo: Memo | null;
  sections: MemoSection[];
  editingContent: Record<string, string>;
  activeSection: string | null;
  addSectionType: string;
  addSectionTitle: string;
  addSectionAI: boolean;
  setSections: Dispatch<SetStateAction<MemoSection[]>>;
  setEditingContent: Dispatch<SetStateAction<Record<string, string>>>;
  setActiveSection: Dispatch<SetStateAction<string | null>>;
  setGeneratingSection: Dispatch<SetStateAction<string | null>>;
  setSavingSection: Dispatch<SetStateAction<string | null>>;
  setShowAddSection: Dispatch<SetStateAction<boolean>>;
  setAddSectionTitle: Dispatch<SetStateAction<string>>;
  setAddSectionType: Dispatch<SetStateAction<string>>;
  setAddingSectionLoading: Dispatch<SetStateAction<boolean>>;
  setPendingDeleteSection: Dispatch<SetStateAction<{ id: string; title: string } | null>>;
  setGeneratingAll: Dispatch<SetStateAction<boolean>>;
  setGenerationStatus: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function createGenerateSection(deps: SectionDeps) {
  const { selectedMemo, setSections, setEditingContent, setGeneratingSection, setError } = deps;
  return async (sectionId: string) => {
    if (!selectedMemo) return;
    setGeneratingSection(sectionId);
    try {
      const result = await api.post<{ content: string }>(`/memos/${selectedMemo.id}/sections/${sectionId}/generate`, {});
      setSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, content: result.content, aiGenerated: true } : s))
      );
      setEditingContent((prev) => ({ ...prev, [sectionId]: result.content }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI generation failed");
    } finally {
      setGeneratingSection(null);
    }
  };
}

export function createSaveSection(deps: SectionDeps) {
  const { selectedMemo, editingContent, setSections, setSavingSection, setError } = deps;
  return async (sectionId: string) => {
    if (!selectedMemo) return;
    setSavingSection(sectionId);
    try {
      await api.patch(`/memos/${selectedMemo.id}/sections/${sectionId}`, {
        content: editingContent[sectionId] || "",
      });
      setSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, content: editingContent[sectionId] || "" } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save section");
    } finally {
      setSavingSection(null);
    }
  };
}

export function createAddSection(
  deps: SectionDeps,
  generateSection: (sectionId: string) => Promise<void>,
) {
  const {
    selectedMemo,
    sections,
    addSectionType,
    addSectionTitle,
    addSectionAI,
    setSections,
    setEditingContent,
    setActiveSection,
    setShowAddSection,
    setAddSectionTitle,
    setAddSectionType,
    setAddingSectionLoading,
    setError,
  } = deps;
  return async () => {
    if (!selectedMemo) return;
    const title = addSectionTitle.trim() || SECTION_TYPES.find((t) => t.value === addSectionType)?.label || "New Section";
    setAddingSectionLoading(true);
    try {
      const body = {
        type: addSectionType,
        title,
        sortOrder: sections.length + 1,
        content: "",
      };
      const created = await api.post<MemoSection>(`/memos/${selectedMemo.id}/sections`, body);
      setSections((prev) => [...prev, created]);
      setEditingContent((prev) => ({ ...prev, [created.id]: "" }));
      setActiveSection(created.id);
      setShowAddSection(false);
      setAddSectionTitle("");
      setAddSectionType("CUSTOM");

      // Auto-generate if checkbox was checked
      if (addSectionAI) {
        generateSection(created.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add section");
    } finally {
      setAddingSectionLoading(false);
    }
  };
}

export function createDeleteSection(deps: SectionDeps) {
  const {
    selectedMemo,
    sections,
    activeSection,
    setSections,
    setEditingContent,
    setActiveSection,
    setPendingDeleteSection,
    setError,
  } = deps;
  return async (sectionId: string) => {
    if (!selectedMemo) return;
    setPendingDeleteSection(null);
    try {
      await api.delete(`/memos/${selectedMemo.id}/sections/${sectionId}`);
      setSections((prev) => prev.filter((s) => s.id !== sectionId));
      setEditingContent((prev) => {
        const next = { ...prev };
        delete next[sectionId];
        return next;
      });
      if (activeSection === sectionId) {
        setActiveSection(sections.find((s) => s.id !== sectionId)?.id || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete section");
    }
  };
}

export function createGenerateAll(deps: SectionDeps) {
  const {
    selectedMemo, setSections, setEditingContent, setActiveSection,
    setGeneratingAll, setGenerationStatus, setError,
  } = deps;

  return async () => {
    if (!selectedMemo) return;
    setGeneratingAll(true);
    setGenerationStatus(null);

    const upsertSection = (generated: {
      type: string; title: string; content: string; aiGenerated: boolean;
      tableData?: any; chartConfig?: any;
    }) => {
      setSections((prev) => {
        const idx = prev.findIndex((s) => s.type === generated.type);
        const patch: Partial<MemoSection> = {
          content: generated.content,
          aiGenerated: generated.aiGenerated,
          ...(generated.tableData !== undefined ? { tableData: generated.tableData } : {}),
          ...(generated.chartConfig !== undefined ? { chartConfig: generated.chartConfig } : {}),
        };
        if (idx === -1) {
          return [...prev, {
            id: `pending-${generated.type}`,
            type: generated.type,
            title: generated.title,
            sortOrder: prev.length + 1,
            aiGenerated: generated.aiGenerated,
            content: generated.content,
          } as MemoSection];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch };
        return next;
      });
    };

    try {
      await api.stream(`/memos/${selectedMemo.id}/generate-all`, {}, (event) => {
        const e = event as Record<string, any>;
        if (e.type === "section_start") {
          const label = String(e.sectionType).replaceAll("_", " ").toLowerCase();
          setGenerationStatus(`Generating ${label}... (${e.index}/${e.total})`);
        } else if (e.type === "section_complete") {
          setGenerationStatus(`${e.section.title} ready (${e.index}/${e.total})`);
          upsertSection(e.section);
        } else if (e.type === "critique_start") {
          setGenerationStatus("Reviewing memo quality...");
        } else if (e.type === "section_revised") {
          setGenerationStatus(`Revising ${e.section.title}...`);
          upsertSection(e.section);
        } else if (e.type === "done" && e.sections) {
          const sorted = [...e.sections].sort((a: MemoSection, b: MemoSection) => a.sortOrder - b.sortOrder);
          setSections(sorted);
          const contentMap: Record<string, string> = {};
          sorted.forEach((s: MemoSection) => { contentMap[s.id] = s.content || ""; });
          setEditingContent(contentMap);
          setActiveSection(sorted[0]?.id || null);
        } else if (e.type === "error") {
          setError(e.message || "Failed to generate all sections");
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate all sections");
    } finally {
      setGeneratingAll(false);
      setGenerationStatus(null);
    }
  };
}
