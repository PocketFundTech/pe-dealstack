import { trackedClaudeMessage, isAnthropicAvailable } from './ai/client.js';
import { log } from '../utils/logger.js';

export interface GeneratedInsights {
  summary: string;
  completionPercent: number;
  redFlags: Array<{ id: string; severity: 'high' | 'medium'; title: string; description: string }>;
  missingDocuments: Array<{ id: string; name: string }>;
}

const FOLDER_INSIGHTS_SYSTEM_PROMPT = `You are DealOS AI, a senior due diligence analyst at a top-tier private equity firm. Your job is to analyze a Virtual Data Room folder and provide actionable insights.

Given:
- The folder name (indicates category: Financials, Legal, Commercial, HR, IP, etc.)
- The deal context (company, industry, stage, financials)
- The list of documents currently in this folder (with names, types, sizes, AI analysis summaries)

You must return a JSON object with exactly these fields:

{
  "summary": "2-3 sentence overview of this folder's status and key findings",
  "completionPercent": 0-100 integer estimating how complete this folder is for a typical PE due diligence,
  "redFlags": [
    {
      "id": "rf1",
      "severity": "high" or "medium",
      "title": "Short title of the issue",
      "description": "1-2 sentence explanation of why this is a concern"
    }
  ],
  "missingDocuments": [
    {
      "id": "md1",
      "name": "Name of the document that should be present"
    }
  ]
}

RULES:
1. Be specific to the folder category and industry. A "Financials" folder for a SaaS company needs different docs than one for a manufacturer.
2. For completionPercent: 0 if empty, estimate based on what's present vs what's typically expected.
3. Red flags should be genuine concerns (e.g., "Only projected financials, no historical audited statements", "No IP assignment agreements for a tech company").
4. Missing documents should be standard due diligence items for this folder type that are NOT present. Be practical — don't list 50 items.
5. If the folder is empty, set completionPercent to 0 and list the most critical 5-8 documents that should be uploaded first.
6. Limit red flags to the top 3-5 most important issues.
7. Limit missing documents to 5-10 most critical items.
8. Reference actual document names when discussing what IS present.`;

const FOLDER_INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    completionPercent: { type: 'integer', description: '0-100' },
    redFlags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium'] },
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['id', 'severity', 'title', 'description'],
        additionalProperties: false,
      },
    },
    missingDocuments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'completionPercent', 'redFlags', 'missingDocuments'],
  additionalProperties: false,
};

export async function generateFolderInsights(
  folderName: string,
  dealContext: {
    dealName: string;
    industry?: string;
    stage?: string;
    revenue?: number;
    ebitda?: number;
  },
  documents: Array<{
    name: string;
    type: string;
    size: string;
    aiAnalysisSummary?: string;
    createdAt: string;
  }>
): Promise<GeneratedInsights | null> {
  if (!isAnthropicAvailable()) {
    log.warn('Folder insights generation skipped: Anthropic not configured');
    return null;
  }

  try {
    const docList = documents.length > 0
      ? documents.map((d, i) => `${i + 1}. "${d.name}" (${d.type}, ${d.size})${d.aiAnalysisSummary ? ` — AI: ${d.aiAnalysisSummary}` : ''}`).join('\n')
      : '(No documents uploaded yet)';

    const dealInfo = [
      `Deal: ${dealContext.dealName}`,
      dealContext.industry ? `Industry: ${dealContext.industry}` : null,
      dealContext.stage ? `Stage: ${dealContext.stage}` : null,
      dealContext.revenue ? `Revenue: $${dealContext.revenue}M` : null,
      dealContext.ebitda ? `EBITDA: $${dealContext.ebitda}M` : null,
    ].filter(Boolean).join('\n');

    const userPrompt = `Analyze this VDR folder for due diligence completeness:

FOLDER: ${folderName}

DEAL CONTEXT:
${dealInfo}

DOCUMENTS IN FOLDER (${documents.length} total):
${docList}

Generate insights as JSON.`;

    log.info('Generating folder insights', { folderName, docCount: documents.length });

    const result = await trackedClaudeMessage({
      operation: 'folder_insights',
      role: 'chat',
      system: FOLDER_INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      outputSchema: FOLDER_INSIGHTS_SCHEMA,
      maxTokens: 2000,
    });

    if (!result.text) {
      log.error('No content in Claude response for folder insights');
      return null;
    }

    const parsed = JSON.parse(result.text) as GeneratedInsights;

    // Validate and normalize
    const insights: GeneratedInsights = {
      summary: parsed.summary || 'Analysis complete.',
      completionPercent: Math.max(0, Math.min(100, Math.round(parsed.completionPercent || 0))),
      redFlags: (parsed.redFlags || []).map((rf, idx) => ({
        id: rf.id || `rf-${idx + 1}`,
        severity: rf.severity === 'high' ? 'high' : 'medium',
        title: rf.title || 'Issue Found',
        description: rf.description || '',
      })),
      missingDocuments: (parsed.missingDocuments || []).map((md, idx) => ({
        id: md.id || `md-${idx + 1}`,
        name: md.name || 'Unknown Document',
      })),
    };

    log.info('Folder insights generated', {
      folderName,
      completionPercent: insights.completionPercent,
      redFlagCount: insights.redFlags.length,
      missingDocCount: insights.missingDocuments.length,
    });

    return insights;
  } catch (error) {
    log.error('Error generating folder insights', error);
    return null;
  }
}
