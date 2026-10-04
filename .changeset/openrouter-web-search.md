---
"@karmi/core": patch
"@karmi/ai-sdk": patch
---

Added OpenRouter web search to the AI SDK Provider. Grant `web_search` on an `openrouter` profile. Configure bounded results under `model.providerOptions.openrouter.webSearch`. Search calls use the remaining Harness budget. The Thread keeps returned sources for later replies and reports the billed OpenRouter cost. Terminal Provider errors can include billed Usage, which the Harness records without completing the failed Step.

Stored data change: model `step.started` events can include a reserved Provider Tool budget. Incomplete attempts keep that budget spent during recovery. OpenRouter search results can appear in the Thread as `server_tool` blocks with aggregate source citations. Keep this adapter support when rolling back consumers that have used search.
