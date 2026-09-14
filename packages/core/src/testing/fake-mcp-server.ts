import * as z from "zod/mini";
import type { McpTool } from "../mcp-catalog";
import { fakeOAuthServer, type FakeMcpOAuth, type FakeMcpOAuthOptions, type FakeOAuthServer } from "./fake-mcp-oauth";
import { toJsonSchema, type JsonSchema, type Schema } from "../schema";
import type { ToolAnnotations } from "../tool";

// An in-process remote MCP server. It is a real Streamable HTTP endpoint answering over `fetch` in either
// the 2026-07-28 (stateless) or the 2025-06-18 (initialize + Mcp-Session-Id) Era. Tests reach it only
// through the Scope's Scoped fetch, so egress rules apply to it as to any real server.

/** The MCP protocol Era the fake speaks. */
export type FakeMcpEra = "2026-07-28" | "2025-06-18";

/**
 * One MCP content block as a fake tool returns it. `text` is the common case and the other kinds exercise
 * rendering.
 */
export type FakeMcpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; description?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string }) };

/** What a fake tool's `execute` returns. A string becomes a single text block. */
export type FakeMcpResult =
  | string
  | { content: FakeMcpContent[]; structuredContent?: unknown; isError?: boolean }
  /** An answer that asks the caller for more input, which the Harness never gives. */
  | { resultType: "input_required"; inputRequests: Record<string, unknown> }
  /** A JSON-RPC error instead of a result. */
  | { error: { code: number; message: string } };

/** A tool the fake server lists and calls. */
export interface FakeMcpTool {
  name: string;
  description?: string;
  /** A zod schema for the arguments. Calls are validated against it, and a bad call answers `-32602`. */
  input?: Schema;
  /** Raw JSON Schema advertised in `tools/list` instead of one derived from `input`. */
  inputSchema?: JsonSchema;
  annotations?: Partial<ToolAnnotations>;
  /**
   * Answers a call. It receives the arguments as `input` parsed them, or verbatim without a schema. The loose
   * type lets a fixture read naturally.
   */
  execute: (input: any) => FakeMcpResult | Promise<FakeMcpResult>;
}

/** Options for `fakeMcpServer`. */
export interface FakeMcpServerOptions {
  /** The server name. Its URL is `https://<name>.mcp.test/mcp`, which is what the Scope config registers. */
  name: string;
  /** The tools listed and served at start. `server.tools` can replace them later. */
  tools?: FakeMcpTool[];
  /** The protocol Era the server speaks. Defaults to 2026-07-28. */
  era?: FakeMcpEra;
  /** The `ttlMs` stamped on `tools/list`. Only the 2026 Era carries it. */
  ttlMs?: number;
  /** The `cacheScope` stamped on `tools/list`. Only the 2026 Era carries it. */
  cacheScope?: "public" | "private";
  /** A header every request must carry. A request without it is answered 401. */
  auth?: { header: string; value: string };
  /** Puts the server behind OAuth. Its authorization server lives at the same origin. */
  oauth?: FakeMcpOAuthOptions;
}

/** One JSON-RPC request the server received. */
export interface FakeMcpCall {
  method: string;
  params: unknown;
  headers: Record<string, string>;
}

/** The fake server: its endpoint, its tools, and the record of what it received. */
export interface FakeMcpServer {
  readonly name: string;
  /** The endpoint, `https://<name>.mcp.test/mcp`. */
  readonly url: string;
  /** The tools served. Replace the array to change the Catalogue between Turns. */
  tools: FakeMcpTool[];
  /** Every JSON-RPC request received, in order. */
  readonly calls: FakeMcpCall[];
  /** A `fetch` that answers this server's requests. `routeFetch` composes several. */
  readonly fetch: typeof fetch;
  /** The authorization server and its records. Present when `oauth` was configured. */
  readonly oauth?: FakeMcpOAuth;
  /** Forgets every recorded call and every session. */
  reset(): void;
}

const MODERN = "2026-07-28";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

/** Creates an in-process MCP server reachable at `https://<name>.mcp.test/mcp`. */
export function fakeMcpServer(options: FakeMcpServerOptions): FakeMcpServer {
  const era = options.era ?? MODERN;
  const calls: FakeMcpCall[] = [];
  const sessions = new Set<string>();
  const url = `https://${options.name}.mcp.test/mcp`;
  const oauth: FakeOAuthServer | undefined = options.oauth && fakeOAuthServer(new URL(url).origin, url, options.oauth);
  const server: FakeMcpServer = {
    name: options.name,
    url,
    tools: [...(options.tools ?? [])],
    calls,
    ...(oauth && { oauth: oauth.api }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const routed = await oauth?.handle(request, new URL(request.url));
      if (routed) return routed;
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const headers = Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));
      if (options.auth && headers[options.auth.header.toLowerCase()] !== options.auth.value)
        return new Response("Unauthorized", { status: 401 });
      const message = decodeRpc(await request.json());
      if (!message) return new Response("Bad request", { status: 400 });
      calls.push({ method: message.method, params: message.params, headers });
      const tool = message.method === "tools/call" ? String(message.params?.name) : undefined;
      const challenged = oauth?.gate(headers, tool);
      if (challenged) return challenged;
      return handle(server, era, options, sessions, message, headers);
    }) as typeof fetch,
    reset: () => {
      calls.length = 0;
      sessions.clear();
    },
  };
  return server;
}

function decodeRpc(body: unknown): Rpc | undefined {
  if (!body || typeof body !== "object" || !("method" in body) || typeof body.method !== "string") return undefined;
  const { id, params } = body as { id?: number | string; params?: Record<string, unknown> };
  return { jsonrpc: "2.0", ...(id !== undefined && { id }), method: body.method, ...(params && { params }) };
}

async function handle(
  server: FakeMcpServer,
  era: FakeMcpEra,
  options: FakeMcpServerOptions,
  sessions: Set<string>,
  message: Rpc,
  headers: Record<string, string>,
): Promise<Response> {
  const { id, method, params = {} } = message;
  if (id === undefined) return new Response(null, { status: 202 });
  const modern = era === MODERN;
  const reply = (result: Record<string, unknown>, extra: HeadersInit = {}) =>
    Response.json(
      { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result } : result },
      { headers: extra },
    );
  const error = (code: number, text: string, status = 200) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message: text } }, { status });
  if (method === "server/discover") {
    if (!modern) return error(-32601, "Method not found");
    return reply({
      supportedVersions: [MODERN],
      capabilities: { tools: { listChanged: false } },
      _meta: { [SERVER_INFO_META]: { name: options.name, version: "1.0.0" } },
    });
  }
  if (method === "initialize") {
    if (modern) return error(-32601, "Method not found");
    const session = crypto.randomUUID();
    sessions.add(session);
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : era;
    return reply(
      { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: options.name, version: "1.0.0" } },
      { "mcp-session-id": session },
    );
  }
  if (!modern && !sessions.has(headers["mcp-session-id"] ?? "")) return error(-32600, "Unknown session", 404);
  if (method === "tools/list")
    return reply({
      tools: server.tools.map(describe),
      ...(modern && { ttlMs: options.ttlMs ?? 60_000, cacheScope: options.cacheScope ?? "public" }),
    });
  if (method === "tools/call") return callTool(server, params, reply, error);
  return error(-32601, "Method not found");
}

async function callTool(
  server: FakeMcpServer,
  params: Record<string, unknown>,
  reply: (result: Record<string, unknown>) => Response,
  error: (code: number, text: string) => Response,
): Promise<Response> {
  const tool = server.tools.find((candidate) => candidate.name === params.name);
  if (!tool) return error(-32602, `Unknown tool "${String(params.name)}"`);
  let input: unknown = params.arguments ?? {};
  if (tool.input) {
    const parsed = z.safeParse(tool.input, input);
    if (!parsed.success)
      return error(-32602, `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    input = parsed.data;
  }
  const result = await tool.execute(input);
  if (typeof result === "string") return reply({ content: [{ type: "text", text: result }] });
  if ("error" in result) return error(result.error.code, result.error.message);
  return reply(result);
}

function describe(tool: FakeMcpTool): McpTool {
  const schema = tool.inputSchema ?? (tool.input ? toJsonSchema(tool.input) : { type: "object" });
  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: { ...schema, type: "object" },
    ...(tool.annotations && { annotations: tool.annotations }),
  };
}

/** A `fetch` that routes each request to the fake whose host matches. Any other host goes to `fallback`. */
export function routeFetch(servers: readonly FakeMcpServer[], fallback: typeof fetch = fetch): typeof fetch {
  const byHost = new Map(servers.map((server) => [new URL(server.url).hostname, server.fetch]));
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return (byHost.get(new URL(url).hostname) ?? fallback)(input, init);
  }) as typeof fetch;
}
