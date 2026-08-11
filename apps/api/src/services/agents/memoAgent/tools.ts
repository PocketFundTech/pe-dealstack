// ─── LangChain Tools for Memo Chat Agent ─────────────────────────────────────
// Tools are created per-request with memoId/dealId/orgId baked into closures
// so the LLM only needs to pass query-specific parameters.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../../supabase.js';
import { searchDocumentChunks, buildRAGContext, isRAGEnabled } from '../../../rag.js';
import { log } from '../../../utils/logger.js';
import { wrapDocumentContent } from '../guardrails.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip HTML tags and collapse whitespace for previews */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map AI agent section types to valid DB types (CHECK constraint) */
const SECTION_TYPE_MAP: Record<string, string> = {
  'EXIT_ANALYSIS': 'EXIT_STRATEGY',
  'VALUE_CREATION_PLAN': 'VALUE_CREATION',
  'QUALITY_OF_EARNINGS': 'FINANCIAL_PERFORMANCE',
  'MANAGEMENT_ASSESSMENT': 'CUSTOM',
  'OPERATIONAL_DEEP_DIVE': 'CUSTOM',
};

function normalizeDbSectionType(type: string): string {
  return SECTION_TYPE_MAP[type] || type;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create all memo agent tools with memoId/dealId/orgId baked in via closures */
export function getMemoAgentTools(memoId: string, dealId: string, orgId: string) {

  // ── 1. get_memo_sections ─────────────────────────────────────────────────

  const getMemoSectionsTool = tool(
    async () => {
      try {
        const { data: sections, error } = await supabase
          .from('MemoSection')
          .select('id, type, title, content, sortOrder, aiGenerated')
          .eq('memoId', memoId)
          .order('sortOrder', { ascending: true });

        if (error) throw error;
        if (!sections || sections.length === 0) {
          return 'No sections found for this memo yet.';
        }

        const lines: string[] = [`**Memo Sections (${sections.length} total):**\n`];
        for (const s of sections) {
          const preview = s.content
            ? stripHtml(s.content).slice(0, 150) + (s.content.length > 150 ? '…' : '')
            : '(empty)';
          const aiTag = s.aiGenerated ? ' [AI]' : '';
          lines.push(`- [${s.sortOrder}] **${s.title}** (id: ${s.id}, type: ${s.type}${aiTag})`);
          lines.push(`  Preview: ${preview}`);
        }

        return lines.join('\n');
      } catch (error) {
        log.error('getMemoSections tool error', error);
        return 'Error fetching memo sections.';
      }
    },
    {
      name: 'get_memo_sections',
      description: 'List all sections in the current memo with id, type, title, content preview, sort order, and whether they were AI-generated. Use this to understand what the memo currently contains before making edits.',
      schema: z.object({}),
    }
  );

  // ── 2. get_active_section ────────────────────────────────────────────────

  const getActiveSectionTool = tool(
    async ({ sectionId }) => {
      try {
        const { data: section, error } = await supabase
          .from('MemoSection')
          .select('id, type, title, content, sortOrder, aiGenerated, hasTable, hasChart')
          .eq('id', sectionId)
          .eq('memoId', memoId)
          .single();

        if (error) throw error;
        if (!section) return `Section ${sectionId} not found in this memo.`;

        const fullContent = section.content ? stripHtml(section.content) : '(empty)';
        const lines: string[] = [
          `**Section: ${section.title}**`,
          `ID: ${section.id}`,
          `Type: ${section.type}`,
          `Sort Order: ${section.sortOrder}`,
          `AI Generated: ${section.aiGenerated ? 'Yes' : 'No'}`,
          `Has Table: ${section.hasTable ? 'Yes' : 'No'}`,
          `Has Chart: ${section.hasChart ? 'Yes' : 'No'}`,
          ``,
          `**Full Content:**`,
          fullContent,
        ];

        return lines.join('\n');
      } catch (error) {
        log.error('getActiveSection tool error', error);
        return 'Error fetching section content.';
      }
    },
    {
      name: 'get_active_section',
      description: 'Retrieve the full content (HTML stripped) of a specific memo section by its ID. Use when you need to read the complete text of a section before editing or extending it.',
      schema: z.object({
        sectionId: z.string().describe('The UUID of the memo section to retrieve'),
      }),
    }
  );

  // ── 3. get_deal_financials ───────────────────────────────────────────────

  const getDealFinancialsTool = tool(
    async () => {
      try {
        const { data: statements, error } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, lineItems, extractionConfidence, extractionSource, isActive')
          .eq('dealId', dealId)
          .order('period', { ascending: false });

        if (error) throw error;
        if (!statements || statements.length === 0) {
          return 'No financial statements extracted for this deal yet.';
        }

        const summary: string[] = [
          `**Financial Statements (${statements.length} total):**\n`,
        ];

        // Group by statementType
        const byType: Record<string, typeof statements> = {};
        for (const s of statements) {
          byType[s.statementType] = byType[s.statementType] || [];
          byType[s.statementType].push(s);
        }

        for (const [type, stmts] of Object.entries(byType)) {
          summary.push(`\n**${type}** (${stmts.length} period${stmts.length > 1 ? 's' : ''}):`);
          for (const s of stmts.slice(0, 6)) {
            const items = s.lineItems && typeof s.lineItems === 'object' ? s.lineItems as Record<string, number | null> : {};
            const entries = Object.entries(items).filter(([, v]) => v !== null && v !== undefined);
            const revenue = entries.find(([k]) =>
              k.toLowerCase().includes('revenue') || k.toLowerCase().includes('net sales')
            );
            const ebitda = entries.find(([k]) =>
              k.toLowerCase().includes('ebitda')
            );
            const statusNote = s.isActive ? '' : ' (pending merge review)';
            summary.push(
              `  - ${s.period}: ${entries.length} line items, confidence ${s.extractionConfidence ?? 'N/A'}%, source: ${s.extractionSource}${statusNote}`
            );
            if (revenue) summary.push(`    ${revenue[0]}: $${revenue[1]}M`);
            if (ebitda) summary.push(`    ${ebitda[0]}: $${ebitda[1]}M`);
          }
        }

        return summary.join('\n');
      } catch (error) {
        log.error('getDealFinancials tool error', error);
        return 'Error fetching financial data.';
      }
    },
    {
      name: 'get_deal_financials',
      description: 'Fetch all extracted financial statements for the deal, grouped by statement type (Income Statement, Balance Sheet, Cash Flow). Shows period, confidence, source, and highlights revenue/EBITDA. Use when writing financial sections of the memo.',
      schema: z.object({}),
    }
  );

  // ── 4. search_documents ──────────────────────────────────────────────────

  const searchDocumentsTool = tool(
    async ({ query }) => {
      try {
        if (!isRAGEnabled()) {
          // Fallback: text search on Document.extractedText
          const { data: docs } = await supabase
            .from('Document')
            .select('id, name, type, extractedText')
            .eq('dealId', dealId)
            .not('extractedText', 'is', null);

          if (!docs || docs.length === 0) return 'No documents found for this deal.';

          const queryLower = query.toLowerCase();
          const relevant = docs.filter(d =>
            d.extractedText?.toLowerCase().includes(queryLower) ||
            d.name.toLowerCase().includes(queryLower)
          );

          if (relevant.length === 0) return 'No relevant content found in documents.';

          // Wrap each excerpt in <document> delimiters so the agent
          // treats it as untrusted external data, not instructions (Task 4.7).
          return relevant.map(d => {
            const text = d.extractedText || '';
            const idx = text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 200);
            const end = Math.min(text.length, idx + queryLower.length + 500);
            return wrapDocumentContent(text.slice(start, end), d.name);
          }).join('\n\n');
        }

        const searchResults = await searchDocumentChunks(query, dealId, 8, 0.4);
        if (searchResults.length === 0) return 'No relevant content found in documents.';

        const { data: docs } = await supabase
          .from('Document')
          .select('id, name, type')
          .eq('dealId', dealId);

        // RAG retrieval concatenates user-uploaded document chunks —
        // wrap the block as untrusted external data (Task 4.7).
        return wrapDocumentContent(buildRAGContext(searchResults, docs || []), 'rag-results');
      } catch (error) {
        log.error('searchDocuments tool error', error);
        return 'Error searching documents.';
      }
    },
    {
      name: 'search_documents',
      description: 'Search through all uploaded deal documents using semantic search with fallback to text search. Use when you need to find specific information from CIMs, financial reports, diligence materials, or other VDR documents to support memo content.',
      schema: z.object({
        query: z.string().describe('The search query — what information to find in the documents'),
      }),
    }
  );

  // ── 5. rewrite_section ───────────────────────────────────────────────────

  const rewriteSectionTool = tool(
    async ({ sectionId, instruction }) => {
      // Fetch current content so the caller can use it for the rewrite
      const { data: section } = await supabase
        .from('MemoSection')
        .select('content, title')
        .eq('id', sectionId)
        .eq('memoId', memoId)
        .single();

      const currentContent = section?.content ?? '';

      return JSON.stringify({
        action: 'applied',
        sectionId,
        instruction,
        currentContent,
      });
    },
    {
      name: 'rewrite_section',
      description: 'Signal that a section should be rewritten according to a given instruction. Auto-applies without confirmation. Returns the current section content so the caller can craft the rewritten version. Use for targeted edits, tone adjustments, or figure updates.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section to rewrite'),
        instruction: z.string().describe('Specific rewrite instruction (e.g., "Make the tone more cautious" or "Update revenue figure to $42.3M")'),
      }),
    }
  );

  // ── 6. add_to_section ────────────────────────────────────────────────────

  const addToSectionTool = tool(
    async ({ sectionId, description }) => {
      return JSON.stringify({
        action: 'confirm',
        sectionId,
        description,
        insertPosition: 'append',
      });
    },
    {
      name: 'add_to_section',
      description: 'Propose appending new content to an existing memo section. Returns a confirmation request so the user can approve before content is inserted. Use when adding supplementary paragraphs, bullet points, or data to an existing section.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section to append to'),
        description: z.string().describe('Description of the content to be appended (e.g., "Add a risk paragraph about customer concentration")'),
      }),
    }
  );

  // ── 7. replace_section ───────────────────────────────────────────────────

  const replaceSectionTool = tool(
    async ({ sectionId, description }) => {
      return JSON.stringify({
        action: 'confirm',
        sectionId,
        description,
        insertPosition: 'replace',
      });
    },
    {
      name: 'replace_section',
      description: 'Propose fully replacing the content of an existing memo section. Returns a confirmation request so the user can approve before the section is overwritten. Use when a section needs a complete rewrite rather than a minor edit.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section to replace'),
        description: z.string().describe('Description of what the new content will contain (e.g., "Full rewrite of the Executive Summary with updated deal terms")'),
      }),
    }
  );

  // ── 8. generate_table ────────────────────────────────────────────────────

  const generateTableTool = tool(
    async ({ sectionId, tableDescription }) => {
      return JSON.stringify({
        action: 'confirm',
        sectionId,
        tableDescription,
        type: 'table',
      });
    },
    {
      name: 'generate_table',
      description: 'Propose generating a structured data table for a memo section (e.g., sources & uses, financial summary, risk matrix, comparable transactions). Returns a confirmation request before the table is created.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section where the table will be inserted'),
        tableDescription: z.string().describe('Description of the table to generate (e.g., "Sources & Uses table with senior debt, equity, and management rollover rows")'),
      }),
    }
  );

  // ── 9. generate_chart ────────────────────────────────────────────────────

  const generateChartTool = tool(
    async ({ sectionId, chartType, title, labels, datasets }) => {
      // Build a real Chart.js config from the structured input
      const chartConfig = {
        type: chartType || 'bar',
        title: title || 'Chart',
        data: {
          labels: labels || [],
          datasets: (datasets || []).map((ds: any, i: number) => ({
            label: ds.label || `Series ${i + 1}`,
            data: ds.data || [],
            ...(ds.type ? { type: ds.type } : {}),
            ...(ds.yAxisID ? { yAxisID: ds.yAxisID } : {}),
          })),
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'bottom' as const } },
        },
      };

      return JSON.stringify({
        action: 'confirm',
        sectionId,
        chartConfig,
        preview: `<p><em>Proposed chart: ${title || chartType + ' chart'}</em></p>`,
        type: 'chart',
      });
    },
    {
      name: 'generate_chart',
      description: 'Generate a Chart.js chart for a memo section. You MUST provide the actual data labels and datasets with numeric values. Query financial data first using get_deal_financials if needed.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section where the chart will be inserted'),
        chartType: z.enum(['bar', 'line', 'pie', 'doughnut']).describe('Chart type'),
        title: z.string().describe('Chart title (e.g., "Revenue & EBITDA Trend")'),
        labels: z.array(z.string()).describe('X-axis labels (e.g., ["FY2021", "FY2022", "FY2023"])'),
        datasets: z.array(z.object({
          label: z.string().describe('Dataset label (e.g., "Revenue")'),
          data: z.array(z.number()).describe('Numeric data points matching labels'),
          type: z.string().optional().describe('Override chart type for this dataset (e.g., "line" for mixed charts)'),
          yAxisID: z.string().optional().describe('Y-axis ID for dual-axis charts'),
        })).describe('One or more data series to plot'),
      }),
    }
  );

  // ── 10. add_section ──────────────────────────────────────────────────────

  const addSectionTool = tool(
    async ({ sectionType, title, content }) => {
      try {
        // Get max sortOrder
        const { data: existingSections } = await supabase
          .from('MemoSection')
          .select('sortOrder')
          .eq('memoId', memoId)
          .order('sortOrder', { ascending: false })
          .limit(1);

        const maxSortOrder = existingSections?.[0]?.sortOrder ?? -1;

        const { data: section, error } = await supabase
          .from('MemoSection')
          .insert({
            memoId,
            type: normalizeDbSectionType(sectionType),
            title,
            content: content || '',
            aiGenerated: true,
            sortOrder: maxSortOrder + 1,
          })
          .select('id, title')
          .single();

        if (error) throw error;

        return JSON.stringify({
          action: 'applied',
          sectionId: section.id,
          title: section.title,
          type: 'new_section',
        });
      } catch (error) {
        log.error('addSection tool error', error);
        return JSON.stringify({ success: false, error: 'Failed to create section' });
      }
    },
    {
      name: 'add_section',
      description: `Add a new section to the memo with AI-generated content. You MUST provide the full HTML content for the section — do NOT leave it empty. Use <h3> sub-headings, <p> paragraphs, <ul>/<li> lists, and <strong> for key metrics. The content should be professional PE memo quality.`,
      schema: z.object({
        sectionType: z.string().describe('Section type key (e.g., EXECUTIVE_SUMMARY, FINANCIAL_PERFORMANCE, RISK_ASSESSMENT, MARKET_DYNAMICS, EXIT_ANALYSIS, COMPETITIVE_LANDSCAPE, VALUE_CREATION_PLAN, CUSTOM)'),
        title: z.string().describe('Display title for the new section (e.g., "Exit Strategy", "Strategic Initiatives")'),
        content: z.string().describe('Full HTML content for the section. Must include <h3> sub-headings and <p> paragraphs. Write 3-5 detailed sub-sections with real analysis based on deal data.'),
      }),
    }
  );

  // ── 11. remove_section ───────────────────────────────────────────────────

  const removeSectionTool = tool(
    async ({ sectionId }) => {
      try {
        const { data: section } = await supabase
          .from('MemoSection')
          .select('id, title')
          .eq('id', sectionId)
          .eq('memoId', memoId)
          .single();

        if (!section) return JSON.stringify({ success: false, error: 'Section not found' });

        const { error } = await supabase
          .from('MemoSection')
          .delete()
          .eq('id', sectionId);

        if (error) throw error;

        return JSON.stringify({
          action: 'applied',
          sectionId,
          removed: true,
          title: section.title,
        });
      } catch (error) {
        log.error('removeSectionTool error', error);
        return JSON.stringify({ success: false, error: 'Failed to remove section' });
      }
    },
    {
      name: 'remove_section',
      description: 'Delete/remove a section from the memo. Use when the user asks to delete, remove, or get rid of a specific section. First call get_memo_sections to find the section ID.',
      schema: z.object({
        sectionId: z.string().describe('UUID of the memo section to remove'),
      }),
    }
  );

  // ── Return all tools ──────────────────────────────────────────────────────

  return [
    getMemoSectionsTool,
    getActiveSectionTool,
    getDealFinancialsTool,
    searchDocumentsTool,
    rewriteSectionTool,
    addToSectionTool,
    replaceSectionTool,
    generateTableTool,
    generateChartTool,
    addSectionTool,
    removeSectionTool,
  ];
}
