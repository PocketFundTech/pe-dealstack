import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { openai, isAIEnabled, trackedChatCompletion } from '../openai.js';
import { MODEL_REASONING } from '../utils/aiModels.js';
import { SHARED_GUARDRAILS } from '../services/agents/guardrails.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess, verifyConversationAccess } from '../middleware/orgScope.js';

const router = Router();

// Validation schemas
const createConversationSchema = z.object({
  dealId: z.string().uuid().optional(),
  userId: z.string().uuid(),
  title: z.string().max(500).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
  userId: z.string().uuid(),
});

// System prompt for deal analysis
const DEAL_ANALYST_PROMPT = `You are an expert Private Equity investment analyst assistant for PE OS, a deal management platform.

Your role is to help investment professionals analyze deals, documents, and make informed decisions. You have access to:
- Deal information (financials, metrics, stage)
- Company data
- Document summaries and AI analysis
- Activity history

Provide concise, actionable insights. Use financial terminology appropriately. When analyzing risks or opportunities, be specific and cite relevant data points.`;

// GET /api/conversations - List all conversations
router.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, dealId } = req.query;
    const orgId = getOrgId(req);

    // If dealId specified, verify the deal belongs to user's org
    if (dealId) {
      const dealAccess = await verifyDealAccess(dealId as string, orgId);
      if (!dealAccess) {
        return res.status(404).json({ error: 'Deal not found' });
      }
    }

    let query = supabase
      .from('Conversation')
      .select(`
        *,
        Deal!inner (
          id,
          name,
          organizationId
        )
      `)
      .eq('Deal.organizationId', orgId)
      .order('updatedAt', { ascending: false });

    if (userId) {
      query = query.eq('userId', userId);
    }

    if (dealId) {
      query = query.eq('dealId', dealId);
    }

    const { data: conversations, error } = await query;

    if (error) throw error;

    res.json(conversations || []);
  } catch (error) {
    next(error);
  }
});

// GET /api/conversations/:id - Get a conversation with messages
router.get('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: conversation, error } = await supabase
      .from('Conversation')
      .select(`
        *,
        Deal (
          id,
          name,
          stage,
          organizationId,
          Company (
            id,
            name
          )
        ),
        ChatMessage (
          id,
          role,
          content,
          metadata,
          createdAt
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      throw error;
    }

    // Verify the conversation's deal belongs to user's org
    if (conversation.Deal && conversation.Deal.organizationId !== orgId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Sort messages by createdAt
    if (conversation.ChatMessage) {
      conversation.ChatMessage.sort((a: any, b: any) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }

    res.json(conversation);
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations - Create a new conversation
router.post('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = createConversationSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // If deal-scoped conversation, verify deal belongs to user's org
    if (validation.data.dealId) {
      const orgId = getOrgId(req);
      const dealAccess = await verifyDealAccess(validation.data.dealId, orgId);
      if (!dealAccess) {
        return res.status(404).json({ error: 'Deal not found' });
      }
    }

    const { data: conversation, error } = await supabase
      .from('Conversation')
      .insert(validation.data)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(conversation);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/conversations/:id - Delete a conversation
router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify the conversation's deal (if any) belongs to user's org
    const { data: conv } = await supabase
      .from('Conversation')
      .select('dealId')
      .eq('id', id)
      .single();
    if (conv?.dealId) {
      const dealAccess = await verifyDealAccess(conv.dealId, orgId);
      if (!dealAccess) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    }

    // Delete messages first (cascade should handle this, but being explicit)
    await supabase
      .from('ChatMessage')
      .delete()
      .eq('conversationId', id);

    const { error } = await supabase
      .from('Conversation')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations/:id/messages - Send a message and get AI response
router.post('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const validation = sendMessageSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { content, userId } = validation.data;

    // Get conversation with deal context
    const { data: conversation, error: convError } = await supabase
      .from('Conversation')
      .select(`
        *,
        Deal (
          id,
          name,
          stage,
          status,
          irrProjected,
          mom,
          ebitda,
          revenue,
          industry,
          dealSize,
          aiThesis,
          organizationId,
          Company (
            id,
            name,
            industry,
            description
          )
        ),
        ChatMessage (
          id,
          role,
          content,
          createdAt
        )
      `)
      .eq('id', id)
      .single();

    if (convError) {
      if (convError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      throw convError;
    }

    // Verify the conversation's deal belongs to user's org
    if (conversation.Deal && conversation.Deal.organizationId !== orgId) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Save user message
    const { data: userMessage, error: userMsgError } = await supabase
      .from('ChatMessage')
      .insert({
        conversationId: id,
        role: 'user',
        content,
      })
      .select()
      .single();

    if (userMsgError) throw userMsgError;

    // Update conversation title if first message
    if (!conversation.ChatMessage || conversation.ChatMessage.length === 0) {
      const title = content.length > 50 ? content.substring(0, 47) + '...' : content;
      await supabase
        .from('Conversation')
        .update({ title, updatedAt: new Date().toISOString() })
        .eq('id', id);
    } else {
      await supabase
        .from('Conversation')
        .update({ updatedAt: new Date().toISOString() })
        .eq('id', id);
    }

    // Generate AI response
    let aiResponseContent = '';

    if (isAIEnabled() && openai) {
      try {
        // Build context from deal data
        let contextMessage = '';
        if (conversation.Deal) {
          const deal = conversation.Deal;
          contextMessage = `\n\nCurrent Deal Context:
- Deal: ${deal.name}
- Company: ${deal.Company?.name || 'N/A'}
- Stage: ${deal.stage}
- Industry: ${deal.industry || deal.Company?.industry || 'N/A'}
- Deal Size: $${deal.dealSize ? (deal.dealSize / 1000000).toFixed(1) + 'M' : 'N/A'}
- Projected IRR: ${deal.irrProjected ? deal.irrProjected + '%' : 'N/A'}
- MoM: ${deal.mom ? deal.mom + 'x' : 'N/A'}
- EBITDA: $${deal.ebitda ? (deal.ebitda / 1000000).toFixed(1) + 'M' : 'N/A'}
- Revenue: $${deal.revenue ? (deal.revenue / 1000000).toFixed(1) + 'M' : 'N/A'}
${deal.aiThesis ? `\nAI Investment Thesis: ${deal.aiThesis}` : ''}`;
        }

        // Build message history
        const messages: any[] = [
          { role: 'system', content: DEAL_ANALYST_PROMPT + '\n' + SHARED_GUARDRAILS + contextMessage }
        ];

        // Add previous messages (last 10 for context)
        const previousMessages = conversation.ChatMessage || [];
        previousMessages.slice(-10).forEach((msg: any) => {
          messages.push({ role: msg.role, content: msg.content });
        });

        // Add current message
        messages.push({ role: 'user', content });

        const completion = await trackedChatCompletion('deal_chat', {
          model: MODEL_REASONING,
          messages,
          max_tokens: 4096,
          temperature: 0.7,
        });

        aiResponseContent = completion.choices[0]?.message?.content || 'I apologize, I was unable to generate a response.';
      } catch (aiError) {
        log.error('OpenAI error', aiError);
        aiResponseContent = 'I apologize, there was an error processing your request. Please try again.';
      }
    } else {
      // Fallback response when AI is not available
      aiResponseContent = generateFallbackResponse(content, conversation.Deal);
    }

    // Save AI response
    const { data: aiMessage, error: aiMsgError } = await supabase
      .from('ChatMessage')
      .insert({
        conversationId: id,
        role: 'assistant',
        content: aiResponseContent,
        metadata: { model: isAIEnabled() ? MODEL_REASONING : 'fallback' }
      })
      .select()
      .single();

    if (aiMsgError) throw aiMsgError;

    res.json({
      userMessage,
      aiMessage,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/conversations/:id/messages - Get messages for a conversation
router.get('/conversations/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const convAccess = await verifyConversationAccess(id, orgId);
    if (!convAccess) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { limit, offset } = req.query;

    let query = supabase
      .from('ChatMessage')
      .select('*')
      .eq('conversationId', id)
      .order('createdAt', { ascending: true });

    if (limit) {
      query = query.limit(parseInt(limit as string, 10));
    }

    if (offset) {
      query = query.range(parseInt(offset as string, 10), parseInt(offset as string, 10) + parseInt(limit as string || '50', 10) - 1);
    }

    const { data: messages, error } = await query;

    if (error) throw error;

    res.json(messages || []);
  } catch (error) {
    next(error);
  }
});

// Helper function for fallback responses
function generateFallbackResponse(query: string, deal: any): string {
  const queryLower = query.toLowerCase();

  if (deal) {
    if (queryLower.includes('risk') || queryLower.includes('concern')) {
      return `Based on the available information for ${deal.name}:

**Key Risk Areas to Consider:**
1. **Market Risk**: Evaluate the ${deal.industry || 'industry'} market dynamics and competitive positioning
2. **Financial Risk**: Current metrics show ${deal.irrProjected ? `${deal.irrProjected}% projected IRR` : 'IRR not yet calculated'}
3. **Operational Risk**: Review operational efficiency and management team strength
4. **Integration Risk**: Consider post-acquisition integration complexity

I recommend reviewing the due diligence documents for detailed risk assessment.`;
    }

    if (queryLower.includes('thesis') || queryLower.includes('investment')) {
      return deal.aiThesis || `For ${deal.name}, consider these investment thesis elements:

1. **Value Creation**: Identify operational improvements and growth opportunities
2. **Market Position**: Evaluate competitive advantages in ${deal.industry || 'the market'}
3. **Financial Returns**: Target metrics suggest ${deal.mom ? `${deal.mom}x MoM` : 'return potential'}
4. **Exit Strategy**: Consider potential exit options and timing

Upload more documents for a comprehensive AI-generated thesis.`;
    }

    if (queryLower.includes('metric') || queryLower.includes('financial') || queryLower.includes('number')) {
      return `**${deal.name} Financial Summary:**

- Deal Size: ${deal.dealSize ? `$${(deal.dealSize / 1000000).toFixed(1)}M` : 'Not specified'}
- Projected IRR: ${deal.irrProjected ? `${deal.irrProjected}%` : 'Not calculated'}
- Multiple on Money: ${deal.mom ? `${deal.mom}x` : 'Not specified'}
- EBITDA: ${deal.ebitda ? `$${(deal.ebitda / 1000000).toFixed(1)}M` : 'Not available'}
- Revenue: ${deal.revenue ? `$${(deal.revenue / 1000000).toFixed(1)}M` : 'Not available'}
- Stage: ${deal.stage}

For detailed financial analysis, please review the uploaded financial documents.`;
    }
  }

  return `I'm here to help analyze deals and documents. You can ask me about:

- **Risk Analysis**: "What are the key risks for this deal?"
- **Investment Thesis**: "Generate an investment thesis"
- **Financial Metrics**: "Summarize the financial metrics"
- **Document Analysis**: "What insights are in the uploaded documents?"

${deal ? `Currently viewing: ${deal.name}` : 'Select a deal to get started with contextual analysis.'}`;
}

export default router;
