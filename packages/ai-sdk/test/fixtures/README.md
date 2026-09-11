These minimal, synthetic SSE fixtures exercise the published provider protocols
through the real installed SDK parsers. They contain no production traffic or
credentials. OpenAI-compatible and Cloudflare Gateway reuse the OpenAI protocol.
Anthropic conformance reuses the native adapter's compaction and fallback
fixtures. The MCP fixture supplies complete input in `mcp_tool_use`, matching
the AI SDK's MCP stream contract.

The V4 stream edge cases in `stream.test.ts` are constructed fixtures, covering
metadata that a short text-only exchange cannot exercise. Live recording of
provider responses is not needed to run these deterministic tests.

`recordings.ts` captures the actual `doStream()` output of the installed SDKs
against these SSE fixtures (2026-09-11). Required undefined usage fields and Date
values are restored in TypeScript so the V4 contract is checked by tsc. The
recording replay tests do not depend on SDK parser behavior.
