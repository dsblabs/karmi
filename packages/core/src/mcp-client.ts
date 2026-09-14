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

// This module is the only code that uses `@modelcontextprotocol/client`. A session is one connected Client
// for one server, opened by the caller when first needed, never holding a listen stream, and closed when
// the caller is done. Every SDK error is classified here so nothing above knows the SDK's error classes.

/** What `McpSession.open` needs to reach one server. */
export interface McpConnection {
  url: string;
  /** The plain headers and resolved static auth headers sent on every request. */
  headers: Record<string, string>;
  /** The Turn's scoped fetch, which every request goes through. */
  fetch: typeof fetch;
  /**
   * Reads the current bearer token before every request. The OAuth flow itself runs in ScopeConfig, never
   * here.
   */
  bearer?: () => string | undefined;
  /** The protocol Era the server answered with last time. The session adopts it without probing again. */
  prior?: McpEra;
  /** Aborts the connect and every request on the session. */
  signal?: AbortSignal;
}

/** Why a Tool call failed, classified from the SDK's errors. */
export type McpCallFailure =
  /** The server answered `-32602`. The tool's definition may have changed. */
  | { kind: "invalid_params"; message: string }
  /** The tool asked for interactive input, which karmi does not support. */
  | { kind: "input_required" }
  /** The server answered 401. The token is missing, expired or revoked. */
  | { kind: "unauthorized" }
  /** The server answered `403 insufficient_scope`. It wants more scopes than the token was granted. */
  | { kind: "insufficient_scope"; scope?: string }
  /** Any other failure, with a message for the model. */
  | { kind: "error"; message: string };

/** The result of one Tool call: the server's result, or a classified failure. */
export type McpCallOutcome = { ok: true; result: CallToolResult } | { ok: false; failure: McpCallFailure };

const CLIENT_INFO = { name: "karmi", version: "0" };

/** One connected MCP client for one server. */
export class McpSession {
  private constructor(private readonly client: Client) {}

  /** Connects to the server and returns the session. Throws the SDK's error when the connect fails. */
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
      // The transport must throw on a challenge. The Harness answers it with a refresh, then consent.
      ...(bearer && { authProvider: { token: async () => bearer() }, onInsufficientScope: "throw" }),
    });
    await client.connect(transport, {
      ...(connection.prior && { prior: connection.prior }),
      ...(connection.signal && { signal: connection.signal }),
    });
    return new McpSession(client);
  }

  /** The protocol Era the server answered with. Persist it and pass it as `prior` on the next connect. */
  era(): McpEra {
    const discover = this.client.getDiscoverResult();
    return discover ? { kind: "modern", discover } : { kind: "legacy" };
  }

  /** Every page of `tools/list`, straight from the server, with its freshness hints. */
  async listTools(signal?: AbortSignal): Promise<{ tools: McpTool[]; hints: CacheHints }> {
    const result = await this.client.listTools(undefined, { cacheMode: "bypass", ...(signal && { signal }) });
    return { tools: result.tools, hints: cacheHints(result) };
  }

  /** Calls `tool` with `input` and classifies any failure. Never throws. */
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

  /** Closes the client and its transport. */
  async close(): Promise<void> {
    await this.client.close();
  }
}

function isArguments(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

/** The auth failure `caught` represents, or undefined when it is not an auth failure. */
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

/**
 * The message for an MCP error. A denied egress carries karmi's own JSON body, whose message is returned
 * instead of the SDK's wrapper.
 */
export function describeMcpError(caught: unknown): string {
  if (caught instanceof SdkHttpError) {
    const { text } = caught.data;
    const denial = typeof text === "string" ? decodeEgressDenial(text) : undefined;
    if (denial) return denial;
  }
  return errorMessage(caught);
}
