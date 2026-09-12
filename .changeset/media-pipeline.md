---
"@karmi/core": patch
"@karmi/anthropic": patch
"@karmi/ai-sdk": patch
---

Add Thread-scoped media uploads with MIME sniffing, measured size limits, multipart abort, and presigned GET URLs. Both adapters inline supported media at request-build and replace unavailable or non-viewable content with placeholders. Generated images and native Tool/MCP images become refs at ingress, preserving replay metadata. Thread deletion cancels work and schedules batched removal of conversation state, media, and spill.
