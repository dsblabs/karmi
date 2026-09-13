import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Logger, ScopeId } from "./context";
import type { MediaWriter } from "./media";
import {
  mcpAnnotations,
  nameTools,
  selectTools,
  type McpCatalog,
  type McpReference,
  type McpTool,
  type NamedMcpTool,
} from "./mcp-catalog";
import { describeMcpError, McpSession } from "./mcp-client";
import { connection, type McpRegistry, type McpServerSnapshot } from "./mcp-registry";
import { rawJsonSchema } from "./schema";
import type { Tool, ToolContext, ToolOutputResult } from "./tool";

// One Turn's view of its MCP servers: the catalogues resolved at Turn start, each server's tools as
// ordinary Tool objects, and a lazily opened session per server that lives until the Turn ends.

/** What `resolveToolSet` asks: the Tools one `mcp:` reference selects, in the server's own order. */
export interface McpToolSource {
  tools(ref: McpReference): readonly Tool[];
}

interface ServerEntry {
  server: McpServerSnapshot;
  catalog?: McpCatalog;
  /** Why the catalogue is missing, when it is. */
  error?: string;
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

  /** Resolves every server's catalogue, refreshing the stale ones over the network. */
  static async open(host: McpSourceHost, servers: readonly McpServerSnapshot[]): Promise<McpTurnSource> {
    const source = new McpTurnSource(host);
    for (const server of servers) {
      const entry: ServerEntry = { server, named: [], tools: new Map() };
      const fresh = await host.registry.fresh(host.scope, server, host.egress, host.signal);
      if ("error" in fresh) {
        entry.error = fresh.error;
        host.logger.warn("MCP catalogue unavailable", { server: server.id, error: fresh.error });
      } else source.adopt(entry, fresh.catalog);
      source.servers.set(server.id, entry);
    }
    return source;
  }

  /** Each server's `catalogVersion`, for the Turn's `toolsVersion`; a server without a catalogue reports none. */
  versions(): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const [id, entry] of this.servers) if (entry.catalog) versions[id] = entry.catalog.catalogVersion;
    return versions;
  }

  tools(ref: McpReference): readonly Tool[] {
    const entry = this.servers.get(ref.server);
    if (!entry) return [];
    return selectTools(entry.named, entry.server.config, ref)
      .map(({ name }) => entry.tools.get(name))
      .filter(defined);
  }

  async close(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(open.map((session) => session.then((s) => s.close()).catch(() => undefined)));
  }

  private adopt(entry: ServerEntry, catalog: McpCatalog): void {
    entry.catalog = catalog;
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
    if (entry.server.missing !== undefined)
      return failed(`Credential "${entry.server.missing}" for MCP server "${id}" is missing.`);
    let session: McpSession;
    try {
      session = await this.session(id, entry.server);
    } catch (caught) {
      return failed(`MCP server "${id}" is unreachable: ${describeMcpError(caught)}`);
    }
    const outcome = await session.callTool(tool, input, ctx.signal);
    if (outcome.ok) return render(outcome.result, ctx.media);
    const { failure } = outcome;
    if (failure.kind === "input_required")
      return failed(`Tool "${tool.name}" needs interactive input from a user, which is not supported.`);
    if (failure.kind === "invalid_params") {
      await this.refetch(entry);
      return failed(`${failure.message} The tool's definition has been refreshed; check it before retrying.`);
    }
    return failed(failure.message);
  }

  /** A `-32602` says the catalogue may be out of date: fetch it again and swap the Tools in place. */
  private async refetch(entry: ServerEntry): Promise<void> {
    try {
      this.adopt(
        entry,
        await this.host.registry.refresh(this.host.scope, entry.server, this.host.egress, this.host.signal),
      );
    } catch (caught) {
      this.host.logger.warn("MCP catalogue refresh failed", {
        server: entry.server.id,
        error: describeMcpError(caught),
      });
    }
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
