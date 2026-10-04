---
"@karmi/ai-sdk": minor
---

Added the `capabilities` option to `aiSdk`. It gives the values that you know for a model, for example its context window. Compaction then uses that window. Before, Compaction used 200,000 tokens for each model of `aiSdk`, unless the Agent Spec set `context.window`:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { aiSdk } from "@karmi/ai-sdk";

export const openai = aiSdk(({ modelId, fetch }) => createOpenAI({ fetch })(modelId), {
  capabilities: (modelId) => (modelId === "gpt-5" ? { contextWindow: 400_000 } : undefined),
});
```
