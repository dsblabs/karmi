---
title: Remote MCP servers
---

# Remote MCP servers

An MCP server is a remote Model Context Protocol server that supplies Tools at runtime. You register it in the Scope config. An Agent Spec then refers to it by name, and the model sees its tools next to the Catalogue Tools. [Tools](03-tools.md) describes Catalogue Tools.

## Register a server

A server has an id below `mcp.servers` in the Scope config. An Agent Spec refers to it as `mcp:<id>` for each permitted tool, or as `mcp:<id>/<tool>` for one tool. This sample stores a token, registers the GitHub server and stores an Agent that uses it:

```ts
import type { Scope } from "@karmi/core";

export async function connectGithub(scope: Scope, token: string): Promise<void> {
  await scope.credentials.put("github", `Bearer ${token}`);
  await scope.config.set({
    mcp: {
      servers: {
        github: {
          url: "https://api.githubcopilot.com/mcp/",
          auth: { type: "static", headers: { Authorization: "scope:github" } },
          deny: ["delete_repository"],
          trustAnnotations: true,
        },
      },
    },
    egress: { mcpHosts: ["*.githubcopilot.com"] },
  });
  await scope.agents.put({
    agentId: "support",
    name: "Support",
    instructions: [{ text: "Open a GitHub issue for each bug report." }],
    model: { id: "anthropic/claude-sonnet-5" },
    tools: ["mcp:github"],
  });
}
```

`scope.config.set` replaces the full config document. Read the document with `scope.config.get()` first when the Scope has other settings. To register a server for every Scope, put the same `mcp` object in `createKarmi({ defaults })`.

The model sees each tool with the name `<id>__<tool>`, for example `github__create_issue`. A server id has 1 to 64 characters. The permitted characters are letters, digits, `_` and `-`.

### Server options

| Option             | Default    | Meaning                                                                                   |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------- |
| `url`              | Required   | The URL of the server. karmi refuses a URL that points to a private network.              |
| `auth`             | No auth    | `{ type: "none" }`, `{ type: "static", headers }` or `{ type: "oauth", level }`.          |
| `headers`          | None       | Headers that are not secret. karmi sends them on each request.                            |
| `allow`            | Every tool | The tool names that an Agent can see.                                                     |
| `deny`             | None       | The tool names that an Agent cannot see.                                                  |
| `trustAnnotations` | `false`    | When `true`, annotations such as `readOnlyHint` control parallel calls and approval.      |
| `catalog.ttlMs`    | None       | The cache time of the tool list for a server that sends no time of its own.               |
| `execution`        | `harness`  | `provider` lets the MCP connector of the Provider call the tools. Only Anthropic has one. |

With `trustAnnotations` off, each tool of the server counts as destructive. [Tools](03-tools.md) describes annotations and the Permission Policy.

Each value in `auth.headers` is a credential reference, `scope:<name>` or `deployment:<name>`. The header value is in the credential store and never in the config. [Credentials](12-credentials.md) describes the store.

### Permitted hosts

`egress.mcpHosts` is a list of host patterns that MCP requests can reach. With no list, the Agent can reach each registered server. When the Deployment defaults and the Scope config each have a list, only hosts that match the two lists are permitted.

## The tool list

At the start of a Turn, the Thread gets the tool list of each server that the Agent Spec names. karmi caches the list for each Scope. It gets the list again in these conditions:

- The cache time of the server is over.
- The server answers a call with the error `-32602`.
- You call `scope.mcp.refreshCatalog()`.

`scope.mcp.refreshCatalog(serverId?)` refreshes one server, or each registered server, and returns the new version of each list. The Thread connects to a server only when the Turn first calls one of its tools. karmi supports the protocol versions of 2025 and the version `2026-07-28`.

## OAuth servers

A server with `auth: { type: "oauth", level }` uses a Connection with the name `mcp:<id>`. The `level` tells who holds the grant:

- `agent`: one grant for the Agent, which each User of that Agent shares.
- `user`: one grant for each User.

The optional `scope` sets the OAuth scopes to request. The optional `client: { id, secret? }` is a client that you registered with the authorization server before. Its `secret` is a credential reference.

OAuth needs the Client identity of the Deployment and the two OAuth routes. This sample sets the identity and mounts the routes before the Thread API:

```ts
import { createKarmi, defineAgent } from "@karmi/core";
import { createHttpHandler } from "@karmi/http";

const supportAgent = defineAgent({
  agentId: "support",
  name: "Support",
  instructions: [{ text: "Answer questions about orders." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["mcp:linear"],
});

const karmi = createKarmi({
  catalogue: { agents: [supportAgent] },
  oauth: { origin: "https://agents.example.com", clientName: "Acme Support" },
  defaults: {
    mcp: { servers: { linear: { url: "https://mcp.linear.app/mcp", auth: { type: "oauth", level: "user" } } } },
  },
});

const http = createHttpHandler({ karmi, authenticate: () => ({ scope: "acme", user: "alice" }) });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return (await karmi.oauth.handle(request)) ?? http.fetch(request, env, ctx);
  },
  queue: karmi.queueHandler,
};
```

`origin` is the public origin of the Worker, with no path. `clientName` is the name on the consent screen, and it defaults to the hostname. `karmi.oauth.handle` answers the client document at `/.well-known/karmi-mcp-client.json` and the callback route. It returns `undefined` for each other request. [HTTP](06-http.md) describes `createHttpHandler` and `authenticate`.

### Get the grant

A tool call with no grant pauses the Turn. The Thread emits an `approval.requested` event with `kind: "connect"`, the `serverId`, the `level` and an `authUrl`. Show the `authUrl` to the person. After the person completes OAuth, the callback stores the tokens and wakes the Thread. The call then runs again one time. [Threads](04-threads.md) shows how to read events.

A settings page can start the same flow before a Turn needs it. This sample returns the consent URL for one User:

```ts
import type { Scope } from "@karmi/core";

export async function linearConsentUrl(scope: Scope, user: string): Promise<string> {
  const { authUrl } = await scope.mcp.authorize({
    serverId: "linear",
    user,
    returnTo: "https://app.example.com/settings",
  });
  return authUrl;
}
```

For an agent-level server, pass `agent` and not `user`. `scope.mcp.disconnect({ serverId, user })` removes the grant. `scope.users.connections.list(user)` and `scope.agents.connections.list(agentId)` include each grant as `mcp:<serverId>`.

karmi refreshes an access token that the server refuses. The refresh token stays in the ScopeConfig of the Scope.

## Test with a fake server

`fakeMcpServer` from `@karmi/core/testing` is an MCP server that runs in the test process. Give it to `createTestKarmi` and register its `url` in the Scope config. This sample makes a fake server with one tool:

```ts
import { fakeMcpServer } from "@karmi/core/testing";

export const github = fakeMcpServer({
  name: "github",
  tools: [
    {
      name: "create_issue",
      description: "Creates an issue.",
      execute: () => ({ content: [{ type: "text", text: "Created issue 42." }] }),
    },
  ],
});
```

`github.url` is `https://github.mcp.test/mcp`. `github.calls` records each request that the server gets. Assign a new array to `github.tools` to change the tool list between Turns. [Testing](13-testing.md) describes `createTestKarmi`.
