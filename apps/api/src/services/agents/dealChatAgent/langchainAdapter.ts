// ─── LangChain adapter for the legacy (LangGraph) deal chat path ────
// Task 2/3 ported the 14 dealChatAgent tools from LangChain `tool()`
// wrappers to plain BetaRunnableTool objects (for the new Tool Runner
// streaming path). The legacy runDealChatAgent() still drives
// LangGraph's createReactAgent(), which requires real LangChain
// StructuredTool instances — this wraps a BetaRunnableTool back into
// one, reusing the same business logic (`run`) and Zod schema so
// neither path duplicates tool implementations.

import { tool } from '@langchain/core/tools';
import type { z } from 'zod';

interface BetaRunnableToolLike {
  name: string;
  description: string;
  run: (args: any) => Promise<string>;
}

export function toLangChainTool(betaTool: BetaRunnableToolLike, schema: z.ZodTypeAny) {
  return tool(
    async (args: any) => betaTool.run(args),
    {
      name: betaTool.name,
      description: betaTool.description,
      schema,
    }
  );
}
