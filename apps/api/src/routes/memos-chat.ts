import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { isAIEnabled, trackedChatCompletion } from '../openai.js';
import { log } from '../utils/logger.js';
import { AuditLog } from '../services/auditLog.js';
import { getOrgId } from '../middleware/orgScope.js';
import { runMemoChatAgent } from '../services/agents/memoAgent/index.js';
import { isLLMAvailable } from '../services/llm.js';
import { MODEL_REASONING } from '../utils/aiModels.js';
import { classifyAIErrorObject } from '../utils/aiErrors.js';
import { getFirmContextBlock } from '../services/firmContextService.js';

const router = Router();

// ============================================================
// Validation Schemas
// ============================================================

const generateSectionSchema = z.object({
  customPrompt: z.string().max(2000).optional(),
});

const chatMessageSchema = z.object({
  // Cap chat input — an unbounded body goes straight into the LLM prompt
  // (cost + prompt-stuffing vector). 10k chars ≈ a very long user message.
  content: z.string().min(1).max(10_000),
  sectionId: z.string().uuid().optional(),
  activeSectionId: z.string().uuid().optional(),
});

// ============================================================
// Shared AI Prompt
// ============================================================

const MEMO_ANALYST_PROMPT = `You are a senior Private Equity investment analyst creating investment committee materials.

Your role is to:
1. Generate professional, data-driven investment memo sections
2. Cite specific documents and page numbers when making claims
3. Present balanced analysis with both opportunities and risks
4. Use PE/finance terminology appropriately
5. Structure content with clear headers, bullet points, and tables

When generating sections:
- Executive Summary: 3-4 paragraphs, key thesis, deal highlights, recommendation
- Financial Performance: Include revenue trends, EBITDA margins, growth rates with specific numbers
- Market Dynamics: TAM/SAM analysis, competitive positioning, industry trends
- Risk Assessment: Categorize as High/Medium/Low with mitigations
- Deal Structure: Terms, valuation multiples, returns analysis

Always format output as HTML that can be rendered in a document. Use <p>, <ul>, <li>, <strong> tags.
Include citation placeholders like [Source: CIM p.XX] for data points.`;

// ============================================================
// AI Generation Routes
// ============================================================

// POST /api/memos/:id/sections/:sectionId/generate - Regenerate section with AI
router.post('/:id/sections/:sectionId/generate', async (req, res) => {
  try {
    const { id, sectionId } = req.params;
    const orgId = getOrgId(req);
    const { customPrompt } = generateSectionSchema.parse(req.body);

    if (!isAIEnabled()) {
      return res.status(503).json({ error: 'AI features are not enabled' });
    }

    // Get memo with deal context (org-scoped)
    const { data: memo, error: memoError } = await supabase
      .from('Memo')
      .select(`
        *,
        deal:Deal(
          id, name, stage, industry, dealSize, revenue, ebitda, irrProjected, mom,
          company:Company(name, description),
          documents:Document(name, type, extractedText)
        )
      `)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (memoError) throw memoError;

    // Get section — bound to the verified memo (SECURITY: prevents reading a
    // section that belongs to a memo in another org)
    const { data: section, error: sectionError } = await supabase
      .from('MemoSection')
      .select('*')
      .eq('id', sectionId)
      .eq('memoId', id)
      .single();

    if (sectionError || !section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    // Build context
    const contextParts = [];
    contextParts.push(`## Memo: ${memo.title}`);
    contextParts.push(`Project: ${memo.projectName || 'N/A'}`);

    if (memo.deal) {
      contextParts.push(`\n## Deal Information`);
      contextParts.push(`Name: ${memo.deal.name}`);
      contextParts.push(`Industry: ${memo.deal.industry || 'N/A'}`);
      contextParts.push(`Stage: ${memo.deal.stage}`);
      if (memo.deal.revenue) contextParts.push(`Revenue: $${memo.deal.revenue}M`);
      if (memo.deal.ebitda) contextParts.push(`EBITDA: $${memo.deal.ebitda}M`);
      if (memo.deal.dealSize) contextParts.push(`Deal Size: $${memo.deal.dealSize}M`);
      if (memo.deal.irrProjected) contextParts.push(`Projected IRR: ${memo.deal.irrProjected}%`);
      if (memo.deal.mom) contextParts.push(`MoM: ${memo.deal.mom}x`);

      if (memo.deal.company) {
        contextParts.push(`\nCompany: ${memo.deal.company.name}`);
        if (memo.deal.company.description) {
          contextParts.push(`Description: ${memo.deal.company.description}`);
        }
      }

      if (memo.deal.documents?.length > 0) {
        contextParts.push(`\n## Available Documents`);
        memo.deal.documents.forEach((doc: any) => {
          contextParts.push(`- ${doc.name} (${doc.type})`);
          if (doc.extractedText) {
            contextParts.push(`  Content preview: ${doc.extractedText.substring(0, 500)}...`);
          }
        });
      }
    }

    const context = contextParts.join('\n');

    // Firm-wide standing context (single AI-generated firm-context doc). Empty
    // when none generated yet — guard and inject nothing.
    const firmContext = await getFirmContextBlock(orgId);
    const firmContextBlock = firmContext ? `=== FIRM CONTEXT ===\n${firmContext}\n\n` : '';

    // Build section-specific prompt
    const sectionPrompt = customPrompt ||
      `Generate content for the "${section.title}" section of this investment committee memo.
      Section type: ${section.type}
      Current content: ${section.content || '(empty)'}

      Please generate comprehensive, professional content appropriate for this section.`;

    // Call OpenAI
    const response = await trackedChatCompletion('memo_generation', {
      model: MODEL_REASONING,
      messages: [
        { role: 'system', content: `${firmContextBlock}${MEMO_ANALYST_PROMPT}` },
        { role: 'system', content: `Context:\n${context}` },
        { role: 'user', content: sectionPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000,
    });

    const generatedContent = response.choices[0].message.content;

    // Update section
    const { data: updatedSection, error: updateError } = await supabase
      .from('MemoSection')
      .update({
        content: generatedContent,
        aiGenerated: true,
        aiModel: MODEL_REASONING,
        aiPrompt: sectionPrompt,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', sectionId)
      .eq('memoId', id) // SECURITY: bind the update to the verified memo
      .select()
      .single();

    if (updateError) throw updateError;

    // Audit log AI generation
    await AuditLog.aiGenerate(req, section.title, id);

    res.json(updatedSection);
  } catch (error) {
    log.error('Error generating section', error);
    res.status(500).json({ error: 'Failed to generate section content' });
  }
});

// ============================================================
// Chat Routes
// ============================================================

// POST /api/memos/:id/chat - Send message to AI assistant
router.post('/:id/chat', async (req, res) => {
  try {
    const { id: memoId } = req.params;
    const orgId = getOrgId(req);
    const authId = req.user?.id || null;
    const { content, activeSectionId } = chatMessageSchema.parse(req.body);

    // Resolve internal User ID from auth ID (MemoConversation.userId FK references User.id)
    let userId: string | null = null;
    if (authId) {
      const { data: userRecord } = await supabase
        .from('User')
        .select('id')
        .eq('authId', authId)
        .single();
      userId = userRecord?.id || null;
    }

    // Verify memo exists and belongs to org
    const { data: memo } = await supabase
      .from('Memo')
      .select('id, dealId, title, projectName')
      .eq('id', memoId)
      .eq('organizationId', orgId)
      .single();

    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    if (!isLLMAvailable()) {
      return res.status(503).json({ error: 'AI service unavailable' });
    }

    // Get or create conversation
    let conversationId: string;
    const { data: existingConv } = await supabase
      .from('MemoConversation')
      .select('id')
      .eq('memoId', memoId)
      .eq('userId', userId)
      .order('createdAt', { ascending: false })
      .limit(1)
      .single();

    if (existingConv) {
      conversationId = existingConv.id;
    } else {
      const { data: newConv, error: convError } = await supabase
        .from('MemoConversation')
        .insert({ memoId, userId, title: 'AI Analyst Chat' })
        .select('id')
        .single();

      if (convError || !newConv) {
        log.error('Failed to create conversation:', convError);
        return res.status(500).json({ error: 'Failed to create chat conversation' });
      }
      conversationId = newConv.id;
    }

    // Save user message
    await supabase.from('MemoChatMessage').insert({
      conversationId,
      role: 'user',
      content,
    });

    // Get conversation history
    const { data: historyMessages } = await supabase
      .from('MemoChatMessage')
      .select('role, content')
      .eq('conversationId', conversationId)
      .order('createdAt', { ascending: true })
      .limit(16);

    const history = (historyMessages || [])
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Run ReAct agent
    const result = await runMemoChatAgent({
      memoId,
      dealId: memo.dealId,
      orgId,
      message: content,
      activeSectionId,
      history,
    });

    // Save AI response
    await supabase.from('MemoChatMessage').insert({
      conversationId,
      role: 'assistant',
      content: result.message,
      metadata: {
        model: result.model,
        action: result.action,
        sectionId: result.sectionId,
      },
    });

    // Update conversation timestamp
    await supabase
      .from('MemoConversation')
      .update({ updatedAt: new Date().toISOString() })
      .eq('id', conversationId);

    res.json({
      id: conversationId,
      role: 'assistant',
      content: result.message,
      model: result.model,
      timestamp: new Date().toISOString(),
      action: result.action,
      sectionId: result.sectionId,
      preview: result.preview,
      tableData: result.tableData,
      chartConfig: result.chartConfig,
      insertPosition: result.insertPosition,
      type: result.type,
      sectionType: result.sectionType,
      title: result.title,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Memo chat error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// GET /api/memos/:id/conversations - Get chat history
router.get('/:id/conversations', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    const { data: conversations, error } = await supabase
      .from('MemoConversation')
      .select(`
        id,
        title,
        updatedAt,
        messages:MemoChatMessage(id, role, content, createdAt)
      `)
      .eq('memoId', id)
      .order('updatedAt', { ascending: false });

    if (error) throw error;

    // Sort messages within each conversation
    conversations?.forEach((conv: any) => {
      if (conv.messages) {
        conv.messages.sort((a: any, b: any) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      }
    });

    res.json(conversations || []);
  } catch (error) {
    log.error('Error fetching conversations', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

export default router;
