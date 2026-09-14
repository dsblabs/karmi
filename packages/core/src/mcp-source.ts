import { computeScopeUnion, type CallToolResult } from "@modelcontextprotocol/client";
import type { Logger, ScopeId } from "./context";
import type { MediaWriter } from "./media";
import type { McpHolder } from "./mcp-auth";
import {
  mcpAnnotations,
  nameTools,
  selectTools,
  type McpCatalog,
  type McpReference,
  type McpTool,
  type NamedMcpTool,
} from "./mcp-catalog";
import { classifyAuth, describeMcpError, McpSession, type McpCallOutcome } from "./mcp-client";
import { connection, type McpRegistry, type McpServerSnapshot } from "./mcp-registry";
import type { ProviderMcpServer } from "./provider";
import { rawJsonSchema } from "./schema";
import type { Tool, ToolContext, ToolOutputResult } from "./tool";

// One Turn's view of its MCP servers: the catalogues resolved at Turn start, each server's tools as
// ordinary Tool objects, and a lazily opened session per server that lives until the Turn ends.

/** What `resolveToolSet` asks: the Tools one `mcp:` reference selects, in the server's own order. */
export interface McpToolSource {
  tools(ref: McpReference): readonly Tool[];
  scriptUnavailable?(name: string): boolean;
}

/** A call that cannot run until its holder consents; the tool Step turns it into a `connect` Approval. */
export interface ConnectRequest {
  serverId: string;
  level: "agent" | "user";
  holder: McpHolder;
  /** The scopes to ask for: the grant's own plus what the server challenged with, on a step-up. */
  scope?: string;
}

/** Thrown by an MCP Tool's `execute` in place of a result; only the tool Step catches it. */
export class McpConnectRequired extends Error {
  override readonly name = "McpConnectRequired";

  constructor(readonly request: ConnectRequest) {
    super(`Connection "mcp:${request.serverId}" has not been granted.`);
  }
}

/** One server of the Turn: its snapshot (whose `catalog` a refresh replaces) and the Tools built from it. */
interface ServerEntry {
  server: McpServerSnapshot;
  named: NamedMcpTool[];
  tools: Map<string, Tool>;
}

export interface McpSourceHost {
  scope: ScopeId;
  registry: McpRegistry;
  egress: typeof fetch;
  logger: Logger;
  signal: AbortSignal;
}

export class McpTurnSource implements McpToolSource {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly sessions = new Map<string, Promise<McpSession>>();

  private constructor(private readonly host: McpSourceHost) {}

  /** Resolves every server's catalogue, refreshing the stale ones through the Turn's own session. */
  static async open(host: McpSourceHost, servers: readonly McpServerSnapshot[]): Promise<McpTurnSource> {
    const source = new McpTurnSource(host);
    for (const server of servers) {
      const entry: ServerEntry = { server, named: [], tools: new Map() };
      source.servers.set(server.id, entry);
      // The provider lists a connector server itself.
      if (server.config.execution === "provider") continue;
      // A user-less Thread cannot reach a user-level server: its tools are offered from the cache so a call can say so.
      if (server.oauth && !server.oauth.holder) {
        if (server.catalog) source.adopt(entry, server.catalog);
        continue;
      }
      const session = () => source.session(server.id, server);
      const current = await host.registry.currentCatalog(host.scope, server, session, host.signal);
      if (current.ok) source.adopt(entry, current.value);
      else host.logger.warn("MCP catalogue unavailable", { server: server.id, error: current.message });
    }
    return source;
  }

  /** Each server's `catalogVersion`, for the Turn's `toolsVersion`; a server without a catalogue reports none. */
  versions(): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const [id, { server }] of this.servers) if (server.catalog) versions[id] = server.catalog.catalogVersion;
    return versions;
  }

  tools(ref: McpReference): readonly Tool[] {
    const entry = this.servers.get(ref.server);
    if (!entry) return [];
    return selectTools(entry.named, entry.server.config, ref)
      .map(({ name }) => entry.tools.get(name))
      .filter(defined);
  }

  scriptUnavailable(name: string): boolean {
    for (const { server, tools } of this.servers.values())
      if (tools.has(name)) return server.oauth !== undefined && !server.oauth.holder;
    return false;
  }

  /** The servers the model provider connects to itself, with the token it needs; one without a grant is left out. */
  providerServers(): ProviderMcpServer[] {
    const servers: ProviderMcpServer[] = [];
    for (const [id, { server }] of this.servers) {
      if (server.config.execution !== "provider") continue;
      if (server.oauth && !server.oauth.token) {
        this.host.logger.warn("MCP connector server left out: no grant", { server: id });
        continue;
      }
      const { allow, deny } = server.config;
      servers.push({
        name: id,
        url: server.config.url,
        ...(server.oauth?.token && { authorization: server.oauth.token }),
        ...(allow && { allow }),
        ...(deny && { deny }),
      });
    }
    return servers;
  }

  async close(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(open.map((session) => session.then((s) => s.close()).catch(() => undefined)));
  }

  private adopt(entry: ServerEntry, catalog: McpCatalog): void {
    entry.named = nameTools(entry.server.id, catalog.tools);
    entry.tools = new Map(entry.named.map((named) => [named.name, this.tool(entry.server, named)]));
  }

  private tool(server: McpServerSnapshot, { tool, name }: NamedMcpTool): Tool {
    return Object.freeze({
      kind: "tool" as const,
      name,
      description: tool.description ?? tool.title ?? tool.name,
      input: rawJsonSchema(tool.inputSchema),
      annotations: mcpAnnotations(tool, server.config.trustAnnotations === true),
      execute: (input: unknown, ctx: ToolContext<unknown>) => this.call(server.id, tool, input, ctx),
    });
  }

  private session(id: string, server: McpServerSnapshot): Promise<McpSession> {
    let session = this.sessions.get(id);
    if (!session) {
      session = McpSession.open({ ...connection(server, this.host.egress), signal: this.host.signal });
      this.sessions.set(id, session);
      session.catch(() => this.sessions.delete(id));
    }
    return session;
  }

  private async call(id: string, tool: McpTool, input: unknown, ctx: ToolContext<unknown>): Promise<ToolOutputResult> {
    const entry = this.servers.get(id);
    if (!entry) return failed(`MCP server "${id}" is not part of this Turn.`);
    const { server } = entry;
    if (server.missing !== undefined)
      return failed(`Credential "${server.missing}" for MCP server "${id}" is missing.`);
    const { oauth } = server;
    if (oauth && !oauth.holder)
      return failed(
        `connection.unavailable: Connection "mcp:${id}" is user-level and this Thread has no User to hold it.`,
      );
    if (oauth?.holder && !oauth.token)
      throw new McpConnectRequired({ serverId: id, level: oauth.level, holder: oauth.holder });
    let outcome = await this.attempt(entry, tool, input, ctx.signal);
    // A refused token gets one refresh and one more try; only then does the holder have to consent again.
    if (!outcome.ok && outcome.failure.kind === "unauthorized" && oauth?.holder) {
      const refreshed = await this.host.registry.refreshToken(this.host.scope, server);
      if (refreshed) outcome = await this.attempt(entry, tool, input, ctx.signal);
      if (!outcome.ok && outcome.failure.kind === "unauthorized")
        throw new McpConnectRequired({ serverId: id, level: oauth.level, holder: oauth.holder });
    }
    if (outcome.ok) return render(outcome.result, ctx.media);
    const { failure } = outcome;
    if (failure.kind === "insufficient_scope" && oauth?.holder) {
      const scope = computeScopeUnion(oauth.scope, failure.scope);
      throw new McpConnectRequired({ serverId: id, level: oauth.level, holder: oauth.holder, ...(scope && { scope }) });
    }
    if (failure.kind === "unauthorized" || failure.kind === "insufficient_scope")
      return failed(`MCP server "${id}" refused the request as unauthorized.`);
    if (failure.kind === "input_required")
      return failed(`Tool "${tool.name}" needs interactive input from a user, which is not supported.`);
    if (failure.kind === "invalid_params") {
      await this.refetch(entry);
      return failed(`${failure.message} The tool's definition has been refreshed; check it before retrying.`);
    }
    return failed(failure.message);
  }

  /** One session open plus one call; an open that the server refuses classifies like a refused call. */
  private async attempt(
    entry: ServerEntry,
    tool: McpTool,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpCallOutcome> {
    let session: McpSession;
    try {
      session = await this.session(entry.server.id, entry.server);
    } catch (caught) {
      const auth = classifyAuth(caught);
      if (auth) return { ok: false, failure: auth };
      return {
        ok: false,
        failure: {
          kind: "error",
          message: `MCP server "${entry.server.id}" is unreachable: ${describeMcpError(caught)}`,
        },
      };
    }
    return session.callTool(tool, input, signal);
  }

  /** A `-32602` says the catalogue may be out of date: list it again over the open session and swap the Tools in place. */
  private async refetch(entry: ServerEntry): Promise<void> {
    const { server } = entry;
    const session = () => this.session(server.id, server);
    const listed = await this.host.registry.list(this.host.scope, server, session, this.host.signal);
    if (listed.ok) this.adopt(entry, listed.value);
    else this.host.logger.warn("MCP catalogue refresh failed", { server: server.id, error: listed.message });
  }
}

const defined = <T>(value: T | undefined): value is T => value !== undefined;
const failed = (text: string): ToolOutputResult => ({ content: [{ type: "text", text }], isError: true });

/** MCP content into a Tool result: text stays, images ride to the media ingress, binary resources spill to media. */
export async function render(result: CallToolResult, media: MediaWriter): Promise<ToolOutputResult> {
  const content: ToolOutputResult["content"] = [];
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "audio":
        content.push(await spill(media, block.data, block.mimeType));
        break;
      case "resource_link":
        content.push({
          type: "text",
          text: `Resource ${block.name} (${block.uri})${block.description ? `: ${block.description}` : ""}`,
        });
        break;
      case "resource":
        if ("text" in block.resource)
          content.push({ type: "text", text: `${block.resource.uri}:\n${block.resource.text}` });
        else
          content.push(
            await spill(
              media,
              block.resource.blob,
              block.resource.mimeType ?? "application/octet-stream",
              block.resource.uri,
            ),
          );
        break;
      default:
        break;
    }
  }
  return {
    content,
    ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
    ...(result.isError === true && { isError: true }),
  };
}

async function spill(
  media: MediaWriter,
  base64: string,
  mimeType: string,
  name?: string,
): Promise<ToolOutputResult["content"][number]> {
  try {
    const ref = await media.put(fromBase64(base64), { mimeType, ...(name !== undefined && { name }) });
    return { type: "media", media: ref };
  } catch {
    return { type: "text", text: "[media unavailable]" };
  }
}

function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
