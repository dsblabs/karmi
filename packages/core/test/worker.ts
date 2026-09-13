import { z } from "zod";
import {
  defineDeliverer,
  type ThreadEvent,
  defineAgent,
  defineFragment,
  defineHook,
  defineSkill,
  defineTool,
  type ToolContext,
  type ToolOutcome,
  type ToolResult,
} from "../src/index";
import { createTestKarmi, fakeMcpServer } from "../src/testing/index";

/** What the Tools and Hooks below saw, in order; tests read and reset it. */
export const trace: string[] = [];
export const deliveries: { key: string; events: ThreadEvent[]; ref: unknown }[] = [];
export const deliveryFailure = { remaining: 0 };
const receipt = defineDeliverer({
  name: "receipt",
  granularity: "turn",
  deliver: (key, events, ref) => {
    if (deliveryFailure.remaining > 0) {
      deliveryFailure.remaining--;
      throw new Error("Delivery unavailable");
    }
    deliveries.push({ key, events, ref });
  },
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const weather = defineTool({
  name: "weather",
  description: "Current weather for a city",
  input: z.object({ city: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  execute: ({ city }) => `Sunny in ${city}`,
});

// Read-only: a batch of these should overlap.
const lookup = defineTool({
  name: "lookup",
  description: "Look a guest up",
  input: z.object({ id: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ id }) => {
    trace.push(`lookup:start:${id}`);
    await settle(20);
    trace.push(`lookup:end:${id}`);
    return `Guest ${id}`;
  },
});

// Mutating: never overlaps with anything.
const book = defineTool({
  name: "book",
  description: "Book a room",
  input: z.object({ room: z.number() }),
  execute: async ({ room }) => {
    trace.push(`book:start:${room}`);
    await settle(20);
    trace.push(`book:end:${room}`);
    return { content: [{ type: "text", text: `Booked ${room}` }], structuredContent: { room } };
  },
});

const bigOutput = defineTool({
  name: "big_output",
  description: "Returns many numbered lines",
  input: z.object({ lines: z.number() }),
  annotations: { readOnlyHint: true },
  execute: ({ lines }) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
});

const whoami = defineTool({
  name: "whoami",
  description: "Reports the Tool context",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  settings: z.object({ tone: z.string() }),
  requires: "crm",
  instructions: defineFragment({ name: "whoami-instructions", render: () => "Call whoami when asked who you are." }),
  execute: (_, ctx: ToolContext<{ tone: string }>) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          scope: ctx.scope,
          user: ctx.user,
          thread: ctx.thread,
          settings: ctx.settings,
          connection: ctx.connection,
          attempt: ctx.attempt,
          callId: ctx.callId,
          aborted: ctx.signal.aborted,
        }),
      },
    ],
  }),
});

const failing = defineTool({
  name: "failing",
  description: "Always throws",
  input: z.object({}),
  execute: () => {
    throw new Error("boom");
  },
});

// Parking fixture: a Tool that hands its work to a Job.
const startJob = defineTool({
  name: "start_job",
  description: "Starts a background job",
  input: z.object({ job: z.string() }),
  execute: ({ job }) => ({ pending: job }),
});

/**
 * A read-only Tool that blocks until the test opens the gate, so a test can act mid-Step deterministically.
 * It polls on a timer of its own rather than awaiting a test-side promise: a continuation resolved from
 * the test context would run there, outside the Durable Object's I/O context.
 */
export const gate = { open: false };
export const untilOpen = async () => {
  while (!gate.open) await settle(5);
};
const waitGate = defineTool({
  name: "wait_gate",
  description: "Waits for the test",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  execute: async () => {
    await untilOpen();
    return "released";
  },
});

const guest = defineFragment({
  name: "guest",
  args: z.object({ hotel: z.string() }),
  render: (ctx, { hotel }) => `You serve ${ctx.user ?? "the front desk"} at ${hotel}.`,
});

const rewriteCity = defineHook({
  name: "rewrite-city",
  point: "before-tool",
  run: ({ call }) => (call.name === "weather" ? { effect: "allow", input: { city: "Paris" } } : undefined),
});
const denyBooking = defineHook({
  name: "deny-booking",
  point: "before-tool",
  run: ({ call }) => (call.name === "book" ? { effect: "deny", reason: "No bookings today" } : undefined),
});
const denyLookup = defineHook({
  name: "deny-lookup",
  point: "before-tool",
  run: () => ({ effect: "deny", reason: "Not now" }),
});
const observe = defineHook({
  name: "observe",
  point: "after-tool",
  run: ({ call, result }) => void trace.push(`after-tool:${call.name}:${result.isError ? "error" : "ok"}`),
});
const turnLog = defineHook({
  name: "turn-start",
  point: "before-turn",
  run: ({ input, turn }) => void trace.push(`before-turn:${turn}:${input.kind}`),
});
const turnEnd = defineHook({
  name: "turn-end",
  point: "after-turn",
  run: ({ end, turn, signal }) => void trace.push(`after-turn:${turn}:${end.type}${signal.aborted ? ":aborted" : ""}`),
});
// Slow enough that an answer can land while the park's after-turn Hooks are still running.
const slowTurnEnd = defineHook({
  name: "slow-turn-end",
  point: "after-turn",
  run: async () => void (await settle(30)),
});
const onError = defineHook({
  name: "on-error",
  point: "on-error",
  run: ({ error }) => void trace.push(`on-error:${error.code}`),
});
// Compaction Hooks: `thread.compact({ instructions })` steers the gate; the log observes every outcome.
const compactGate = defineHook({
  name: "compact-gate",
  point: "before-compact",
  run: ({ trigger, instructions, tokensBefore }) => {
    trace.push(`before-compact:${trigger}:${tokensBefore > 0}`);
    if (instructions === "skip") return { skip: true };
    if (instructions === "hook") return { summary: "HOOK SUMMARY" };
    return undefined;
  },
});
const compactLog = defineHook({
  name: "compact-log",
  point: "after-compact",
  run: ({ compacted }) => void trace.push(`after-compact:${compacted.strategy}:${compacted.firstKeptSeq}`),
});

const concierge = defineAgent({
  agentId: "concierge",
  name: "Concierge",
  instructions: [
    { text: "Help the guest." },
    { fragment: "guest", args: { hotel: "The Grand" } },
    { text: "You are Claude.", models: "anthropic/*" },
  ],
  model: { id: "anthropic/claude-sonnet-5", fallbacks: ["anthropic/claude-haiku-4-5"] },
  tools: ["weather", "lookup", "book", "big_output", "failing"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  hooks: {
    "before-turn": ["turn-start"],
    "after-turn": ["turn-end"],
    "after-tool": ["observe"],
    "on-error": ["on-error"],
  },
  context: { toolOutput: { maxChars: 400, maxLines: 10 } },
});

// Policy and Hooks under test: a denied Tool, a rewriting Hook, a Tool with settings and a Connection.
const guarded = defineAgent({
  agentId: "guarded",
  name: "Guarded",
  instructions: [{ text: "Be careful." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather", "book", "lookup", { name: "whoami", settings: { tone: "formal" } }],
  connections: { crm: { type: "crm", level: "agent" } },
  policy: [
    { match: { tool: "book" }, effect: "deny" },
    { match: { annotations: { readOnlyHint: true } }, effect: "allow" },
  ],
  hooks: { "before-tool": ["rewrite-city", "deny-booking"] },
});

// Default Policy: nothing matches, so every call is an `ask`.
const asking = defineAgent({
  agentId: "asking",
  name: "Asking",
  instructions: [{ text: "Ask first." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["book"],
});
// Approvals: `lookup` and the Job/Scope fixtures are allowed, everything else asks, with a one-hour timeout.
const approver = defineAgent({
  agentId: "approver",
  name: "Approver",
  instructions: [{ text: "Ask before booking." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["lookup", "book", "weather", "start_job", "wait_gate"],
  policy: [{ match: { tool: ["lookup", "start_job", "wait_gate"] }, effect: "allow" }],
  approvals: { timeout: 60 * 60 * 1000 },
  hooks: { "after-turn": ["turn-end", "slow-turn-end"] },
});
// Budgets: a tiny `longRunning` grant so exhaustion is a few Steps away.
const budgeted = defineAgent({
  agentId: "budgeted",
  name: "Budgeted",
  instructions: [{ text: "Loop." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["lookup"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  capabilities: { longRunning: { maxSteps: 3, maxTokens: 100 } },
});
const hooked = defineAgent({
  agentId: "hooked",
  name: "Hooked",
  instructions: [{ text: "Hooked." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["lookup"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  hooks: { "before-tool": ["deny-lookup"] },
});

// Compaction: a window small enough that a few Turns fill it; tokens are estimated at four characters each.
const compactContext = { window: 1000, reserveTokens: 100, keepRecentTokens: 100 };
const compactor = defineAgent({
  agentId: "compactor",
  name: "Compactor",
  instructions: [{ text: "Remember everything." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["lookup"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  hooks: { "before-compact": ["compact-gate"], "after-compact": ["compact-log"] },
  context: compactContext,
});
// The same Agent under a profile that delegates the summary to the provider; only the `compact-provider` Scope configures it.
const providerCompactor = defineAgent({
  agentId: "compactor-provider",
  name: "Provider compactor",
  instructions: [{ text: "Remember everything." }],
  model: { id: "anthropic/claude-sonnet-5", providerProfile: "provider-compact" },
  hooks: { "before-compact": ["compact-gate"] },
  context: compactContext,
});

// Progressive disclosure: a shelf of small Tools that only crosses the `auto` threshold under a small window.
const SHELF_TOPICS = [
  "Ancient maps and atlases",
  "Sea charts and maps",
  "Poetry",
  "Botany",
  "Astronomy",
  "Cookery",
  "Law",
  "Music",
  "Medicine",
  "Travel",
  "Geology",
  "Chess",
  "Coins",
  "Textiles",
  "Ceramics",
  "Letters",
  "Theatre",
  "Mathematics",
  "Rivers",
  "Birds",
  "Clocks",
  "Glass",
  "Bridges",
  "Gardens",
];
export const shelves = SHELF_TOPICS.map((topic, i) =>
  defineTool({
    name: `shelf_${String(i + 1).padStart(2, "0")}`,
    description: `${topic}: fetch one item from this shelf of the archive`,
    input: z.object({ item: z.string() }),
    annotations: { readOnlyHint: true },
    execute: ({ item }) => `Shelf ${i + 1} holds ${item}`,
  }),
);
const search = defineTool({
  name: "search",
  description: "Search the archive catalogue",
  input: z.object({ q: z.string() }),
  annotations: { readOnlyHint: true },
  execute: ({ q }) => `Found ${q}`,
});
const research = defineSkill({
  name: "research",
  description: "Deep research into the archive",
  body: (ctx) => `Search first, then summarise for ${ctx.user ?? "the desk"}.`,
  tools: [search],
});
const deploy = defineSkill({
  name: "deploy",
  description: "Deploy checklist",
  body: () => "Deploy checklist.",
  invokableBy: "user",
});
const librarianSpec = {
  name: "Librarian",
  instructions: [{ text: "Keep the archive." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: [{ name: "weather", alwaysLoad: true }, ...shelves.map((tool) => tool.name)],
  skills: [{ name: "research", invokableBy: "model" as const }, "deploy"],
  policy: [{ match: { tool: "*" }, effect: "allow" as const }],
};
const librarian = defineAgent({
  ...librarianSpec,
  agentId: "librarian",
  context: { window: 4000, reserveTokens: 200, keepRecentTokens: 200 },
});
// The same shelf under the default window: well under the threshold, so nothing defers.
const librarianWide = defineAgent({ ...librarianSpec, agentId: "librarian-wide" });

export const recovery = {
  execute: async (_input: { id: string }, _ctx: ToolContext): Promise<ToolOutcome> => "done",
  before: [] as string[],
  after: [] as ToolResult[],
};
const recoveryTools = [
  { name: "recover_read", annotations: { readOnlyHint: true } },
  { name: "recover_idempotent", annotations: { idempotentHint: true } },
  { name: "recover_mutation", annotations: {} },
].map(({ name, annotations }) =>
  defineTool({
    name,
    annotations,
    description: "Recovery fixture",
    input: z.object({ id: z.string() }),
    execute: (input, ctx) => recovery.execute(input, ctx),
  }),
);
const recoveryBefore = defineHook({
  name: "recovery-before",
  point: "before-tool",
  run: ({ call }) => {
    recovery.before.push(call.id);
  },
});
const recoveryAfter = defineHook({
  name: "recovery-after",
  point: "after-tool",
  run: ({ result }) => {
    recovery.after.push(result);
  },
});
const recoveryAgent = defineAgent({
  agentId: "recovery",
  name: "Recovery",
  instructions: [{ text: "Recover." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: recoveryTools.map((t) => t.name),
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  hooks: { "before-tool": ["recovery-before"], "after-tool": ["recovery-after"] },
});

// Credentials fixtures: an Agent on the Scope's own profile that can revoke its credential mid-Turn.
export const revocations: string[] = [];
const revokeCredential = defineTool({
  name: "revoke_credential",
  description: "Revokes a Scope credential",
  input: z.object({ scope: z.string(), name: z.string() }),
  execute: async ({ scope: id, name }) => {
    await secrets.revoke({ scope: id, ref: `scope:${name}` });
    revocations.push(name);
    return "revoked";
  },
});
const byok = defineAgent({
  agentId: "byok",
  name: "BYOK",
  instructions: [{ text: "Use your own key." }],
  model: { id: "fake/m", fallbacks: ["fake/n"], providerProfile: "own" },
  tools: ["revoke_credential", "weather"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
});

// MCP fixtures: a modern (2026-07-28) server behind a static bearer, and a legacy (2025) one.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const github = fakeMcpServer({
  name: "github",
  ttlMs: 60_000,
  auth: { header: "Authorization", value: "Bearer gh-token" },
  tools: [
    {
      name: "search_issues",
      description: "Search issues",
      input: z.object({ q: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
      execute: ({ q }: { q: string }) => `Found ${q}`,
    },
    {
      name: "create_issue",
      description: "Create an issue",
      input: z.object({ title: z.string() }),
      execute: ({ title }: { title: string }) => ({
        content: [{ type: "text" as const, text: `Created ${title}` }],
        structuredContent: { number: 7 },
      }),
    },
    {
      name: "repos.list",
      description: "List repos",
      execute: () => "repo-a, repo-b",
    },
    {
      name: "attach",
      description: "Returns rich content",
      execute: () => ({
        content: [
          { type: "resource" as const, resource: { uri: "gh://readme", mimeType: "text/plain", text: "Hello" } },
          { type: "resource" as const, resource: { uri: "gh://logo", mimeType: "image/png", blob: png } },
          { type: "resource_link" as const, uri: "gh://issues/1", name: "Issue 1" },
        ],
      }),
    },
    {
      name: "ask_user",
      description: "Needs interactive input",
      execute: () => ({
        resultType: "input_required" as const,
        inputRequests: { name: { method: "elicitation/create" } },
      }),
    },
  ],
});
export const legacy = fakeMcpServer({
  name: "legacy",
  era: "2025-06-18",
  tools: [
    {
      name: "echo",
      description: "Echo",
      input: z.object({ text: z.string() }),
      execute: ({ text }: { text: string }) => text,
    },
  ],
});

// OAuth fixtures: a user-level server whose `delete_file` needs a scope the first grant lacks, an agent-level
// server that registers dynamically and issues a client secret, and one that takes only a pre-registered client.
export const drive = fakeMcpServer({
  name: "drive",
  ttlMs: 60_000,
  oauth: { scopes: ["drive:read", "drive:write"], requires: { delete_file: "drive:write" }, expiresIn: 3600 },
  tools: [
    {
      name: "list_files",
      description: "List files",
      annotations: { readOnlyHint: true },
      execute: () => "a.txt, b.txt",
    },
    {
      name: "delete_file",
      description: "Delete a file",
      input: z.object({ name: z.string() }),
      execute: ({ name }: { name: string }) => `Deleted ${name}`,
    },
  ],
});
export const crm = fakeMcpServer({
  name: "crm",
  oauth: { cimd: false, dcrSecret: true },
  tools: [{ name: "contacts", description: "List contacts", execute: () => "alice, bob" }],
});
export const locked = fakeMcpServer({
  name: "locked",
  oauth: { cimd: false, dcr: false, clients: { "my-app": { secret: "s3cret" } } },
  tools: [{ name: "ping", description: "Ping", execute: () => "pong" }],
});
const mcpDrive = defineAgent({
  agentId: "mcp-drive",
  name: "Drive agent",
  instructions: [{ text: "Use the drive." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["mcp:drive"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  approvals: { timeout: 60 * 60 * 1000 },
});
const mcpCrm = defineAgent({
  agentId: "mcp-crm",
  name: "CRM agent",
  instructions: [{ text: "Use the CRM." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather", "mcp:crm"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
  approvals: { timeout: 60 * 60 * 1000 },
});
const mcpLocked = defineAgent({
  agentId: "mcp-locked",
  name: "Locked agent",
  instructions: [{ text: "Ping." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["mcp:locked"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
});

const mcpAgent = defineAgent({
  agentId: "mcp-agent",
  name: "MCP agent",
  instructions: [{ text: "Use the servers." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: ["weather", "mcp:legacy/echo", "mcp:github"],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
});
const mcpPinned = defineAgent({
  agentId: "mcp-pinned",
  name: "MCP pinned",
  instructions: [{ text: "Use the servers." }],
  model: { id: "anthropic/claude-sonnet-5" },
  tools: [{ name: "mcp:github/search_issues", alwaysLoad: true }],
  policy: [{ match: { tool: "*" }, effect: "allow" }],
});

export const { karmi, clock, provider, scope, secrets } = createTestKarmi(
  {
    deliverers: [
      receipt,
      defineDeliverer({ name: "receipt-parts", deliver: receipt.deliver }),
      defineDeliverer({ name: "receipt-deltas", granularity: "delta", deliver: receipt.deliver }),
    ],
    tools: [
      weather,
      lookup,
      book,
      bigOutput,
      whoami,
      failing,
      startJob,
      waitGate,
      revokeCredential,
      ...recoveryTools,
      ...shelves,
    ],
    fragments: [guest],
    skills: [research, deploy],
    hooks: [
      recoveryBefore,
      recoveryAfter,
      rewriteCity,
      denyBooking,
      denyLookup,
      observe,
      turnLog,
      turnEnd,
      slowTurnEnd,
      onError,
      compactGate,
      compactLog,
    ],
    agents: [
      recoveryAgent,
      concierge,
      guarded,
      asking,
      hooked,
      approver,
      budgeted,
      compactor,
      providerCompactor,
      librarian,
      librarianWide,
      byok,
      mcpAgent,
      mcpPinned,
      mcpDrive,
      mcpCrm,
      mcpLocked,
    ],
  },
  {
    mcpServers: [github, legacy, drive, crm, locked],
    credentials: { shared: "deployment-key" },
    defaults: {
      providers: { shared: { adapter: "fake", models: ["*"], credential: "deployment:shared" } },
    },
    media: {
      accountId: "test-account",
      bucket: "karmi-test-media",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
    },
  },
);

export const { ThreadDO, ScopeConfigDO } = karmi.durableObjects;

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === "/describe") return Response.json(karmi.catalogue.describe());
    return new Response("Not found", { status: 404 });
  },
  queue: karmi.queueHandler,
};
