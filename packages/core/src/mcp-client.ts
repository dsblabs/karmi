import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { errorMessage } from "./errors";
import { cacheHints, type CacheHints, type McpEra, type McpTool } from "./mcp-catalog";
import { decodeEgressDenial } from "./scoped-fetch";

// The one seam onto `@modelcontextprotocol/client`: a session is one connected Client for one server,
// opened lazily by the caller, never holding a listen stream, and dropped when the caller is done.
// Every SDK error is classified here so nothing above knows the SDK's error classes.

export interface McpConnection {
  url: string;
  /** Plain and resolved static auth headers, sent on every request. */
  headers: Record<string, string>;
  fetch: typeof fetch;
  /** The bearer token, read before every request; the OAuth flow itself runs in ScopeConfig, never here. */
  bearer?: () => string | undefined;
  /** The era the server answered last time, adopted without a probe. */
  prior?: McpEra;
  signal?: AbortSignal;
}

export type McpCallFailure =
  | { kind: "invalid_params"; message: string }
  | { kind: "input_required" }
  /** A 401: the token is missing, expired or revoked. */
  | { kind: "unauthorized" }
  /** A `403 insufficient_scope`: the server wants more than the token was granted. */
  | { kind: "insufficient_scope"; scope?: string }
  | { kind: "error"; message: string };

export type McpCallOutcome = { ok: true; result: CallToolResult } | { ok: false; failure: McpCallFailure };

const CLIENT_INFO = { name: "karmi", version: "0" };

export class McpSession {
  private constructor(private readonly client: Client) {}

  static async open(connection: McpConnection): Promise<McpSession> {
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      versionNegotiation: { mode: "auto" },
      inputRequired: { autoFulfill: false },
    });
    const { bearer } = connection;
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
      fetch: connection.fetch,
      requestInit: { headers: connection.headers },
      // A challenge is answered by the Harness (refresh, then consent), never by the transport on its own.
      ...(bearer && { authProvider: { token: async () => bearer() }, onInsufficientScope: "throw" }),
    });
    await client.connect(transport, {
      ...(connection.prior && { prior: connection.prior }),
      ...(connection.signal && { signal: connection.signal }),
    });
    return new McpSession(client);
  }

  /** What the server told us about its era, persistable for the next connect. */
  era(): McpEra {
    const discover = this.client.getDiscoverResult();
    return discover ? { kind: "modern", discover } : { kind: "legacy" };
  }

  /** Every page of `tools/list`, straight from the server, with its freshness hints. */
  async listTools(signal?: AbortSignal): Promise<{ tools: McpTool[]; hints: CacheHints }> {
    const result = await this.client.listTools(undefined, { cacheMode: "bypass", ...(signal && { signal }) });
    return { tools: result.tools, hints: cacheHints(result) };
  }

  async callTool(tool: McpTool, input: unknown, signal: AbortSignal): Promise<McpCallOutcome> {
    try {
      const result = await this.client.callTool(
        { name: tool.name, arguments: isArguments(input) ? input : {} },
        { toolDefinition: tool, signal },
      );
      return { ok: true, result };
    } catch (caught) {
      return { ok: false, failure: classify(caught) };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function isArguments(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

/** The auth failures a connect or a call can end in; anything else is an ordinary error. */
export function classifyAuth(
  caught: unknown,
): Extract<McpCallFailure, { kind: "unauthorized" | "insufficient_scope" }> | undefined {
  if (caught instanceof UnauthorizedError) return { kind: "unauthorized" };
  if (caught instanceof InsufficientScopeError)
    return { kind: "insufficient_scope", ...(caught.requiredScope !== undefined && { scope: caught.requiredScope }) };
  if (caught instanceof SdkHttpError && caught.code === SdkErrorCode.ClientHttpAuthentication)
    return { kind: "unauthorized" };
  return undefined;
}

function classify(caught: unknown): McpCallFailure {
  const auth = classifyAuth(caught);
  if (auth) return auth;
  if (caught instanceof ProtocolError && caught.code === -32602)
    return { kind: "invalid_params", message: caught.message };
  if (caught instanceof SdkError && caught.code === SdkErrorCode.UnsupportedResultType && inputRequired(caught))
    return { kind: "input_required" };
  return { kind: "error", message: describeMcpError(caught) };
}

function inputRequired(error: SdkError): boolean {
  const data: unknown = error.data;
  return data !== null && typeof data === "object" && "resultType" in data && data.resultType === "input_required";
}

/** A denied egress answers with karmi's own JSON body; surface its message rather than the SDK's wrapper. */
export function describeMcpError(caught: unknown): string {
  if (caught instanceof SdkHttpError) {
    const { text } = caught.data;
    const denial = typeof text === "string" ? decodeEgressDenial(text) : undefined;
    if (denial) return denial;
  }
  return errorMessage(caught);
}
