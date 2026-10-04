---
"@karmi/ai-sdk": patch
---

Fixed the classification of an error that a provider sends in the stream as a plain JSON body, for example an OpenRouter error. A rate limit or an outage from the provider now gets the `rate_limit` or `unavailable` code, so the Harness tries the model again. Before this fix, the error had the `unknown` code and the message `[object Object]`, and the Turn failed at once.
