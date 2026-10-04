---
"@karmi/ai-sdk": minor
---

Changed `aiSdk` to request prompt caching by default. The Provider adds a cache breakpoint to the system prompt, the last Tool and the last message, with the 5-minute TTL. Anthropic models, directly or through OpenRouter or a gateway, now read the repeated part of the prompt from the cache. Other models ignore the breakpoints.

Added the `cache` option to `aiSdk`. `{ ttl: "1h" }` sets the one-hour TTL. `false` removes the breakpoints:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { aiSdk } from "@karmi/ai-sdk";

export const claude = aiSdk(({ modelId, fetch }) => createAnthropic({ fetch })(modelId), { cache: false });
```
