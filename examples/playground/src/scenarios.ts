import { AGENTS, ASSISTANT_PROMPTS } from "./assistant";
import { DISPATCH_PROMPTS, MAX_STEPS, TURNS } from "./dispatch";
import { CONCIERGE_PROMPTS, MEMORY } from "./concierge";
import { CONTAINER_LIMITS, CONTAINER_PROMPTS, CONTAINERS, EGRESS_ALLOW, type ContainerRuntime } from "./containers";
import { COMPACTION, CONTEXT, LEDGER_PROMPTS } from "./ledger";
import { KNOWLEDGE, LIBRARIAN_PROMPTS } from "./librarian";
import { LIFECYCLE, LIFECYCLE_PROMPTS } from "./lifecycle";
import { FORKS, FORKS_PROMPT } from "./media-forks";
import { OBSERVABILITY, OBSERVABILITY_PROMPTS } from "./observability";
import type { ProviderSetup } from "./provider-options";
import { PROVIDER_PROMPTS, PROVIDERS, WEB_SEARCH_LIMITS } from "./provider-desk";
import { DELEGATION, PURCHASE_PROMPTS } from "./purchases";
import { REFUND, REFUND_PROMPT } from "./refund";
import { REMINDER_PROMPTS, SCHEDULES } from "./reminders";
import { MCP, MCP_PROMPTS } from "./remote-mcp";
import { SCRIPT_LIMITS, SCRIPT_PROMPTS, SCRIPTS } from "./scripts";
import { STOCKROOM, STOCKROOM_PROMPTS } from "./stockroom";
import { VECTOR_BINDINGS } from "./vector-config";
import { VECTOR_PROMPTS, VECTORS, type VectorIndex } from "./vectors";

const CODE = "https://github.com/dsblabs/karmi/blob/main/examples/playground";

/** A model feature that a scenario needs. */
export type ModelFeature = "media" | "toolCalls";

/** A prompt that a scenario suggests. The operator can edit it before the run. */
export interface SuggestedPrompt {
  /** The feature that the prompt shows. */
  label: string;
  text: string;
}

/** One guided scenario, or one that the Playground does not have yet. */
export interface Scenario {
  id: string;
  /** The coverage group of the specification that the scenario belongs to. */
  group: string;
  title: string;
  /** What the scenario shows, in one or two sentences. */
  summary: string;
  /** False for a scenario that the Playground does not have yet. */
  built: boolean;
  /** What the operator must have before the scenario can run, other than Provider setup. */
  prerequisites: string[];
  /** The model features that the scenario needs. */
  needs: ModelFeature[];
  /** The prompts that the scenario suggests. The page puts the first one in the editor. */
  prompts?: SuggestedPrompt[];
  /** The link to the example code. */
  code?: string;
  /** True when the composer shows the Turn controls: steer, queue and cancel. */
  controls?: boolean;
  /** True when the composer sends one file with the prompt. */
  upload?: boolean;
  /** True when the scenario needs the `KARMI_LOADER` binding of the Worker. */
  needsLoader?: boolean;
  /** True when the scenario needs a container runtime: Docker in local development, or Cloudflare Containers. */
  needsContainers?: boolean;
  /** True when the scenario needs Workers AI and a Vectorize index. */
  needsVectors?: boolean;
  /** What the operator must know before a run, other than a limit of the model. */
  notes?: string[];
}

const notBuilt = (id: string, group: string, title: string, prerequisites: string[] = []): Scenario => ({
  id,
  group,
  title,
  summary: "The Playground does not have this scenario yet.",
  built: false,
  prerequisites,
  needs: [],
});

/** Each scenario of the Playground. A scenario that is not built stays in the list with its prerequisites. */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: REFUND,
    group: "Threads",
    title: "Approve or deny a refund",
    summary:
      "An Agent looks up a sample order and asks to refund it. The refund Tool has no Policy rule, so the Framework stops the call until you allow or deny it.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: [{ label: "Approval", text: REFUND_PROMPT }],
    code: `${CODE}/src/refund.ts`,
  },
  {
    id: AGENTS,
    group: "Agents",
    title: "Change an Agent at runtime",
    summary:
      "The Scope stores the Agent Spec of this Agent as data. Change the instructions, the Fragment arguments or a Capability grant, and the next Turn uses the new version. The Scope rejects a grant above its ceiling.",
    built: true,
    prerequisites: [],
    needs: [],
    prompts: ASSISTANT_PROMPTS,
    code: `${CODE}/src/assistant.ts`,
  },
  {
    id: STOCKROOM,
    group: "Tools",
    title: "Tools, Skills and a Hook",
    summary:
      "An Agent changes a sample stock system. One Tool is deferred until the model finds it. A Skill adds a procedure and a Tool. The Permission Policy denies one Tool, and a Hook writes each call to an audit log.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: STOCKROOM_PROMPTS,
    code: `${CODE}/src/stockroom.ts`,
  },
  {
    id: TURNS,
    group: "Threads",
    title: "Control a Turn and its parked work",
    summary: `An Agent packs a sample dispatch. Add an input to the running Turn or queue it for the next one, and cancel the Turn. The Turn parks for a continuation Approval after ${String(MAX_STEPS)} Steps, and it parks again while a courier Job runs.`,
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: DISPATCH_PROMPTS,
    code: `${CODE}/src/dispatch.ts`,
    controls: true,
  },
  {
    id: COMPACTION,
    group: "Threads",
    title: "Compaction and recovery",
    summary: `An Agent keeps a sample ledger. Its context window is ${String(CONTEXT.window)} tokens, thus a short conversation makes the Harness compact the Thread. Hold the ledger, stop the dev server during a Tool call and start it again. The Thread recovers the Turn from its event log.`,
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: LEDGER_PROMPTS,
    code: `${CODE}/src/ledger.ts`,
  },
  {
    id: FORKS,
    group: "Threads",
    title: "Media and independent Thread Forks",
    summary:
      "Upload a file as real stored bytes, fork the Thread at a completed Turn, then delete the original. The Fork keeps its own media copy.",
    built: true,
    prerequisites: [],
    needs: ["media"],
    prompts: [{ label: "Describe the file", text: FORKS_PROMPT }],
    code: `${CODE}/src/media-forks.ts`,
    upload: true,
  },
  {
    id: DELEGATION,
    group: "Delegation",
    title: "Child Threads and their Approvals",
    summary:
      "A shop manager Agent gives each purchase task to a purchase desk Agent. The child runs in its own Thread with new context. The parent shows the Approval of the child and gets its final answer as the Tool result. Cancel the parent Turn, and the child stops too.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: PURCHASE_PROMPTS,
    code: `${CODE}/src/purchases.ts`,
    controls: true,
  },
  {
    id: SCHEDULES,
    group: "Schedules and delivery",
    title: "Schedules, external triggers and offline delivery",
    summary:
      "Create delayed, timed and recurring Schedules, or let the Agent create one. Each Schedule that fires starts a Turn. Detach the Subscriber of the page, and a Deliverer writes each completed Turn and each Approval request to a sample inbox.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: REMINDER_PROMPTS,
    code: `${CODE}/src/reminders.ts`,
  },
  {
    id: MEMORY,
    group: "Memory and Knowledge",
    title: "User Memory and Scope isolation",
    summary:
      "A concierge Agent remembers the preferences of the User with the built-in remember Tool. A new Thread of the same User gets them in its Memory Fragment. Inspect and delete the Memory, and see that the same User in a second sample Scope has none of it.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: CONCIERGE_PROMPTS,
    code: `${CODE}/src/concierge.ts`,
  },
  {
    id: KNOWLEDGE,
    group: "Memory and Knowledge",
    title: "Knowledge ingestion and document search",
    summary:
      "A librarian Agent searches a handbook corpus with the search_handbook Tool and gets a notices corpus in its Prompt. Ingest, update and delete documents. Compare the Passages of a search with the answer of the Agent. Run a bulk ingest Job. The built-in Retriever is full-text search and needs no external service.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: LIBRARIAN_PROMPTS,
    code: `${CODE}/src/librarian.ts`,
  },
  {
    id: VECTORS,
    group: "Memory and Knowledge",
    title: "Vector retrieval and index rebuild",
    summary:
      "A shop guide Agent searches a guides corpus with a vector Retriever in hybrid mode. Workers AI embeds each chunk, and a Vectorize index keeps a copy of each vector. Compare keyword, vector and hybrid Passages. Remove the vectors from the index, then rebuild it from the Knowledge of the Framework.",
    built: true,
    prerequisites: [
      "A Cloudflare deployment that selected vector retrieval. pnpm deploy then creates a Vectorize index with 1024 dimensions, the cosine metric and two metadata indexes, and binds Workers AI. Local development has no Workers AI or Vectorize.",
    ],
    needs: ["toolCalls"],
    prompts: VECTOR_PROMPTS,
    code: `${CODE}/src/vectors.ts`,
    needsVectors: true,
    notes: [
      "The Knowledge scenario uses the default Retriever, fts5, which finds a Passage only when a word of the query is in it. This Retriever also finds a Passage with the same meaning and different words.",
      "The Knowledge Durable Object keeps each vector. The Vectorize index is a copy that a rebuild writes again without a call to the embedding model.",
      "Vectorize applies writes asynchronously. In a live check, a change took one to two minutes to show. Wait until the index card shows the new count, and select Read the index again. A remove deletes only the vectors that the index already shows.",
      "Each ingest calls Workers AI, and each search calls Workers AI and Vectorize. Cloudflare bills the use above the free allocation of your plan.",
    ],
  },
  {
    id: SCRIPTS,
    group: "Scripts",
    title: "Isolate Scripts",
    summary:
      "The model runs your JavaScript in an isolate. The Script calls the sample Tools that the Permission Policy allows, and each nested call names its Script. A Script cannot call a Tool that needs an Approval or use the network. The Harness stops a Script at its limits or when you cancel the Turn.",
    built: true,
    prerequisites: [
      "The KARMI_LOADER binding. The local development server has it. A Cloudflare deployment needs the Workers Paid plan: select isolate Scripts when pnpm deploy asks.",
    ],
    needs: ["toolCalls"],
    prompts: SCRIPT_PROMPTS,
    code: `${CODE}/src/scripts.ts`,
    controls: true,
    needsLoader: true,
    notes: [
      `Local workerd does not enforce cpuMs, thus the CPU limit Script finishes in local development. Only a deployed Worker shows the limit of ${String(SCRIPT_LIMITS.cpuMs)} ms.`,
    ],
  },
  {
    id: CONTAINERS,
    group: "Scripts",
    title: "Container Scripts, files and artifacts",
    summary:
      "The model runs your shell or Python Script in a container Workspace. The Script reads the sample files in /in and writes artifacts to /out, which you can download. A long process becomes a Job with progress, and a cancel stops it. The Worker lets a Script reach only the hostnames of the allow-list.",
    built: true,
    prerequisites: [
      "A container runtime. For local development, run pnpm dev:containers, which needs Docker and builds a linux/amd64 image. A Cloudflare deployment needs the Workers Paid plan: select container Scripts when pnpm deploy asks.",
    ],
    needs: ["toolCalls"],
    prompts: CONTAINER_PROMPTS,
    code: `${CODE}/src/containers.ts`,
    controls: true,
    needsContainers: true,
    notes: [
      `The Workspace belongs to the Thread. Its files stay between the Scripts of one Turn. The Harness destroys it when the Turn ends, after ${String(CONTAINER_LIMITS.idleMs / 1000)} seconds without a Script, on a cancel and on a reset. Each call empties /in and /out first.`,
      `A Script reaches only ${EGRESS_ALLOW.join(", ")}. Cloudflare enforces this rule. The Playground does not claim that local Docker enforces it the same way.`,
      "The Playground does not use LocalProcessSandbox. That sandbox runs a Script as a process of your computer, with access to your files and with no network rule, thus it is not an isolated sandbox.",
    ],
  },
  {
    id: LIFECYCLE,
    group: "Scopes and credentials",
    title: "Scope lifecycle, credentials and key rotation",
    summary:
      "The scenario runs in a disposable Scope. Suspend it and resume it, or destroy it and follow the Destroy walk. Store a Scope credential that no route returns, then test it, revoke it and see the next Step fall back to the credential of setup. Rotate the key ring from a terminal and rewrap each credential.",
    built: true,
    prerequisites: [],
    needs: [],
    prompts: LIFECYCLE_PROMPTS,
    code: `${CODE}/src/lifecycle.ts`,
    notes: [
      "The Scope credential can be the same key that you gave to pnpm setup, or a second key of the same Provider. The page never shows it again.",
      "A destroy is permanent. A reset destroys the disposable Scope and moves to a new Scope id. It does not change the Provider credential of setup.",
      "Key rotation needs a terminal. The README of the Playground tells each command.",
    ],
  },
  {
    id: MCP,
    group: "Providers and MCP",
    title: "Remote MCP Tools and OAuth Connections",
    summary:
      "Register a real remote MCP server in a disposable Scope, with no credential, with a static header or with a user-level OAuth Connection. The Agent gets the Tools of the server, and the Permission Policy decides each call. When the Turn has a tool list but no grant, a call asks for the Connection in the conversation and continues after OAuth.",
    built: true,
    prerequisites: [
      "A remote MCP server with a public https URL. karmi refuses a private address, and the Worker reaches public hosts only.",
      "For a server with a static credential: the header value that the server expects, for example a Bearer token.",
      "For a server with OAuth: PLAYGROUND_ORIGIN, the public https origin of the Playground, which pnpm deploy sets. The authorization server must accept a Client ID Metadata Document or Dynamic Client Registration.",
    ],
    needs: ["toolCalls"],
    prompts: MCP_PROMPTS,
    code: `${CODE}/src/remote-mcp.ts`,
    notes: [
      "The Playground has no sample MCP server. The server that you register is a real service, and each allowed call can change its data.",
      "A reset destroys the disposable Scope with the registration, the Scope credential, the Connection and the cached tool list, and moves to a new Scope id. It does not revoke the grant at the authorization server.",
      "A Turn can offer the Tools of a server only from a tool list. Most servers list their Tools only for a User with a grant, thus the first Connection comes from Connect in the Connection card.",
    ],
  },
  {
    id: PROVIDERS,
    group: "Providers and MCP",
    title: "Provider switching, Provider Tools and AI Gateway",
    summary:
      "The Agent Spec of this Agent names a Provider profile. Switch to a different profile, and the next Turn of the same Thread runs on that Provider. Grant the Provider Tool web_search, which the Provider runs, next to a Tool that the Harness runs. Send the calls through Cloudflare AI Gateway and read the log id in the Usage record.",
    built: true,
    prerequisites: [
      "For a switch: a second Provider profile. pnpm setup asks for an optional second Provider. It can be a second model of the same Provider.",
      "For AI Gateway: a gateway in your Cloudflare account. pnpm setup asks for its account id, its id and a token for an authenticated gateway. The Playground does not create or delete a gateway.",
    ],
    // The Harness Tool prompt needs Tool calls. The Provider Tool needs a profile that the Profiles card names.
    needs: ["toolCalls"],
    prompts: PROVIDER_PROMPTS,
    code: `${CODE}/src/provider-desk.ts`,
    notes: [
      "karmi offers web_search on the Anthropic Provider and on OpenAI models of the AI SDK Provider. The Profiles card shows the Provider Tools that the Framework accepts on each profile. A grant on a different profile gets capability.unavailable.",
      `A Provider Tool runs at the Provider, inside the model call. A Permission Policy rule can allow or deny it, but not ask, because there is no call that can wait for you. The grant allows ${String(WEB_SEARCH_LIMITS.maxCallsPerTurn)} calls in a Turn and ${String(WEB_SEARCH_LIMITS.maxCallsPerThread)} in the Thread.`,
      "Cloudflare AI Gateway reports no cost in the answer. The Usage record has the gateway log id. karmi never prices tokens, thus the page shows no cost for these calls.",
    ],
  },
  notBuilt("http", "HTTP and media", "WebSocket and reconnects"),
  {
    id: OBSERVABILITY,
    group: "Observability",
    title: "Usage records, costs and logs",
    summary:
      "Run a Turn and inspect Usage records with their Scope, Agent, User, Thread and seq. The Agent does not know its spend. Each model call writes a record, and the Usage records card shows it. The page shows a cost only when the Provider or a gateway reported one. A sample UsageHandler receives each record at least once. A Tool log redacts credentials.",
    built: true,
    prerequisites: [],
    needs: ["toolCalls"],
    prompts: OBSERVABILITY_PROMPTS,
    code: `${CODE}/src/observability.ts`,
  },
  notBuilt("operations", "Development and operations", "Test kit, doctor, deployment and removal", [
    "Deployment needs a Cloudflare account.",
  ]),
];

/** The state of a scenario for the current setup. */
export type ScenarioStatus = "ready" | "unavailable" | "incomplete";

/** A scenario with its state for the current setup. */
export interface ScenarioView extends Scenario {
  status: ScenarioStatus;
  /** Why the scenario is not ready. */
  reason?: string;
  /** Limits of the selected model that the operator must know before the scenario runs. */
  modelNotes: string[];
}

/** The optional services of the Worker that some scenarios need. */
export interface Services {
  /** Whether the Worker has the `KARMI_LOADER` binding of isolate Scripts. */
  hasLoader: boolean;
  /** Where container Scripts run, when the Worker has a container runtime. */
  containers?: ContainerRuntime | undefined;
  /** The external vector index, when the Worker has Workers AI and a Vectorize index. */
  vectors?: VectorIndex | undefined;
}

/** Adds the state for the current setup and services to a scenario. It makes no network call. */
export function viewScenario(
  scenario: Scenario,
  setup: ProviderSetup | undefined,
  { hasLoader, containers, vectors }: Services,
): ScenarioView {
  if (!scenario.built)
    return { ...scenario, status: "incomplete", reason: "This scenario is not built yet.", modelNotes: [] };
  if (scenario.needsLoader && !hasLoader)
    return {
      ...scenario,
      status: "unavailable",
      reason:
        "The Worker has no KARMI_LOADER binding. Deploy again with a new deployment name and select isolate Scripts. Dynamic Workers need the Workers Paid plan.",
      modelNotes: [],
    };
  if (scenario.needsContainers && !containers)
    return {
      ...scenario,
      status: "unavailable",
      reason:
        "The Worker has no container runtime. For local development, stop the server and run pnpm dev:containers, which needs Docker. For Cloudflare, deploy with a new deployment name and select container Scripts.",
      modelNotes: [],
    };
  if (scenario.needsVectors && !vectors)
    return {
      ...scenario,
      status: "unavailable",
      reason: `The Worker has no ${VECTOR_BINDINGS.ai} binding for Workers AI or no ${VECTOR_BINDINGS.index} binding for Vectorize. Local development has neither. Run pnpm deploy and select vector retrieval.`,
      modelNotes: [],
    };
  if (!setup)
    return {
      ...scenario,
      status: "unavailable",
      reason: "No Provider is set up. Run `pnpm setup` in examples/playground, then start the Playground again.",
      modelNotes: [],
    };
  const modelNotes = [
    ...(scenario.needs.includes("toolCalls") && !setup.option.toolCalls
      ? [
          `This scenario needs a model that supports Tool calls. The Playground cannot check that for ${setup.model}. A model without Tool calls answers in text only, and no Tool call appears.`,
        ]
      : []),
    ...(scenario.needs.includes("media")
      ? [
          `Images, audio, video and PDF can reach a compatible model. Other files remain stored and downloadable, but the model receives a file placeholder. Check the media support and size limit of ${setup.model}.`,
        ]
      : []),
  ];
  return { ...scenario, status: "ready", modelNotes };
}

/** One row of the feature coverage view. */
export interface CoverageRow {
  group: string;
  feature: string;
  /** The id of the scenario that shows the feature, when one does. */
  scenario?: string;
  /** What the operator does and sees. */
  observable?: string;
  /** How the row was verified. */
  verification?: string;
}

const row =
  (scenario: string) =>
  (feature: string, group: string, observable: string): CoverageRow => ({
    group,
    feature,
    scenario,
    observable,
    verification: "Worker tests with the scripted Provider, and browser checks.",
  });

const shown = row(REFUND);
const agents = row(AGENTS);
const tools = row(STOCKROOM);
const turns = row(TURNS);
const forks = row(FORKS);
const schedules = row(SCHEDULES);
const compaction = row(COMPACTION);
const delegation = row(DELEGATION);
const memory = row(MEMORY);
const observability = row(OBSERVABILITY);
const scripts = row(SCRIPTS);
const knowledge = row(KNOWLEDGE);
const lifecycle = row(LIFECYCLE);
// The tests use the fake MCP servers of the Test kit. Each row tells what a check by hand with a real server covered.
const mcp = (feature: string, observable: string, verification: string): CoverageRow => ({
  group: "Providers and MCP",
  feature,
  scenario: MCP,
  observable,
  verification: `Worker tests with the scripted Provider and the fake MCP servers of the Test kit. ${verification}`,
});
// No Provider, Provider Tool or gateway was checked live, thus each row says so.
const providers = (feature: string, group: string, observable: string): CoverageRow => ({
  group,
  feature,
  scenario: PROVIDERS,
  observable,
  verification:
    "Worker tests and browser checks with the scripted Provider. Unit tests check the gateway URL and the cf-aig headers of the OpenAI and Anthropic clients. No check with a real Provider, Provider Tool or AI Gateway ran yet.",
});
// The tests use a deterministic Embedder and an index in memory, thus each row tells what a live check covered.
const vectors = (feature: string, observable: string): CoverageRow => ({
  group: "Memory and Knowledge",
  feature,
  scenario: VECTORS,
  observable,
  verification:
    "Worker tests and browser checks with the scripted Provider, a deterministic Embedder and an index in memory. Checked by hand with wrangler dev, remote Workers AI and a temporary Vectorize index: ingest, the three searches, remove, rebuild with the same ids and reset. No Agent Turn with a real model, and no pnpm deploy with vector retrieval, ran yet.",
});
// The tests run container Scripts on a fake container runtime, thus the rows say that no real container ran yet.
const containers = (feature: string, group: string, observable: string): CoverageRow => ({
  ...row(CONTAINERS)(feature, group, observable),
  verification:
    "Worker tests and browser checks with the scripted Provider and a fake container runtime. Not verified in a real container yet.",
});

/** The delivered feature coverage. A row without a scenario is a feature that no scenario shows yet. */
export const COVERAGE: readonly CoverageRow[] = [
  shown("Instructions and model selection", "Agents", "The Agent runs on the model that setup selected."),
  agents("Agent Specs stored at runtime", "Agents", "Save a changed Spec. The next Turn uses the new version."),
  agents("Prompts and Fragments", "Agents", "The page shows the text that each Prompt entry gives to the model."),
  agents("Capability ceilings", "Agents", "A grant in the Scope ceiling gets a version. A larger grant gets an issue."),
  tools("Validated Tool inputs", "Tools", "A change of more than 100 units gets an error result. The stock stays."),
  tools("Structured results", "Tools", "The event log shows the structuredContent of each stock result."),
  tools("Permission Policy: deny", "Tools", "The model cannot see or run delete_product."),
  tools("Annotations in a Policy rule", "Tools", "A rule for readOnlyHint allows check_stock, which no rule names."),
  tools("Hooks", "Tools", "An after-tool Hook adds one audit line for each Tool call."),
  tools("Skills", "Tools", "use_skill adds a tools.loaded event, the Skill body and the order_supplier Tool."),
  tools("Deferred Tools", "Tools", "tool_search adds a tools.loaded event before adjust_stock can run."),
  shown("Tool inputs and results", "Tools", "The event log shows each Tool call and its result."),
  shown("Annotations and Permission Policy", "Tools", "The read-only lookup runs. The refund waits for an Approval."),
  shown("Approvals", "Threads", "Allow changes the sample order. Deny leaves it unchanged."),
  turns("Inputs during a Turn", "Threads", "A steered input joins the Turn. A queued input starts the next Turn."),
  turns("Cancellation during a Turn", "Threads", "Cancel ends the Turn. The booking that a Tool made stays."),
  turns("Budgets", "Threads", "The Turn parks after its Steps. Allow gives a new budget. Deny ends the Turn."),
  turns("Jobs", "Threads", "The courier Tool parks the Turn. A reported outcome resumes it."),
  forks("Forks", "Threads", "Select a completed Turn and inspect the original and Fork as separate Threads."),
  forks("Independent Fork media", "Threads", "Delete the original, then download the bytes from the Fork."),
  compaction(
    "Compaction",
    "Threads",
    "A compact Step runs before a model Step when the context is over the limit. The Thread shows the summary and the first kept event. The Agent continues.",
  ),
  compaction("Compaction on request", "Threads", "Compact the Thread with instructions while it is idle."),
  compaction(
    "Recovery",
    "Development and operations",
    "Stop the dev server during a Tool call. The Thread recovers the Turn from its event log and keeps each finished Tool result.",
  ),
  compaction(
    "Interrupted Tool calls",
    "Development and operations",
    "A read-only call runs again. A call without idempotentHint gets an error result with interrupted.",
  ),
  delegation(
    "Delegation",
    "Delegation",
    "The delegate Tool starts a child Thread. The parent Turn parks until the child answers, and the answer is the Tool result.",
  ),
  delegation(
    "Parent and child Threads",
    "Delegation",
    "The Child Threads card shows each child with its parent key and call id. The conversation shows the child in its own card.",
  ),
  delegation(
    "Approvals of a child",
    "Delegation",
    "The parent shows the Approval of the child. Allow places the order. Deny gives the child an error result.",
  ),
  delegation(
    "Cancellation of a child",
    "Delegation",
    "Cancel the parent Turn while the child waits. The child Turn fails with cancelled. Reset deletes each child.",
  ),
  delegation(
    "Usage records of a Delegation",
    "Observability",
    "The Usage records card lists the records of the parent and of each child. A child record names its parent. No record occurs two times.",
  ),
  memory(
    "Memory Profile and Notes",
    "Memory and Knowledge",
    "The remember Tool writes the roast to the Profile and a Note. The Memory card shows both, with the fields of the Agent.",
  ),
  memory(
    "Memory across Threads",
    "Memory and Knowledge",
    "Start a new Thread. The Agent answers from the Memory Fragment without a Tool call. The event log of the new Thread has no earlier event.",
  ),
  memory(
    "Memory search",
    "Memory and Knowledge",
    "The recall Tool finds a Note by its words and returns it as the result.",
  ),
  memory(
    "Memory inspection and deletion",
    "Memory and Knowledge",
    "The Memory card reads the Memory with scope.users.memory. Forget deletes it, and the next Thread does not know the preference.",
  ),
  memory(
    "Scope isolation",
    "Scopes and credentials",
    "The same User in the second sample Scope has an empty Memory. A Thread key of one Scope gets a 404 answer through the other.",
  ),
  memory(
    "Users of a Scope",
    "Scopes and credentials",
    "The Memory card lists each User with a stored Memory in the Scope.",
  ),
  observability(
    "Usage records",
    "Observability",
    "The Usage records card lists each usage.recorded event with Scope, Agent, User, Thread and seq. A closed card shows the parent field of a Delegation child. This scenario does not start a child Thread.",
  ),
  observability(
    "Reported costs",
    "Observability",
    "A record shows cost only when the Provider or gateway reported it. A missing cost is not zero and is not priced from tokens.",
  ),
  observability(
    "UsageHandler delivery",
    "Observability",
    "The Queue delivers each record to the sample UsageHandler. A failed batch retries. A second delivery of the same threadId:seq is a duplicate.",
  ),
  observability(
    "Logs and redaction",
    "Observability",
    "The lookup Tool logs credential-shaped fields. The stored line has markers. The redaction route shows `redactFields` on the same sample object.",
  ),
  scripts(
    "Isolate Tools",
    "Scripts",
    "The Tool calls Script calls find_orders and read_order. Each nested call shows under its run_script call with the parentCallId of the Script.",
  ),
  scripts(
    "Script results and logs",
    "Scripts",
    "The Script runs card shows the value or the error, the console lines and the nested Tool calls of each Script.",
  ),
  scripts(
    "Tool restrictions of a Script",
    "Scripts",
    "The Script lists its Tools. cancel_order needs an Approval, thus it is not in tools, and the call throws.",
  ),
  scripts("Network rules of an isolate", "Scripts", "A fetch from a Script fails. The isolate has no network access."),
  scripts(
    "Script limits",
    "Scripts",
    "The Harness ends a Script at maxToolCalls and at wallMs with a limit_exceeded error. Local workerd does not enforce cpuMs.",
  ),
  {
    group: "Scripts",
    feature: "CPU limit of a Script",
    scenario: SCRIPTS,
    observable: "On Cloudflare, the CPU limit Script fails with limit_exceeded: cpuMs. Locally, it finishes.",
    verification:
      "Not verified in a Cloudflare account yet. No automatic check can run, because local workerd does not enforce cpuMs.",
  },
  scripts(
    "Script cancellation",
    "Scripts",
    "Cancel the Turn while the Cancel Script packs boxes. The Script stops. The boxes that it packed stay packed. Reset leaves no Script running.",
  ),
  containers(
    "Container execution",
    "Scripts",
    "The Python report and the Shell summary Scripts run in the Workspace of the Thread. The Script runs card shows the language, the code, the exit code, stdout and stderr.",
  ),
  containers(
    "Script files",
    "Scripts",
    "The Agent gets the refs of sales.csv and returns.csv from a Fragment. The Script reads them in /in.",
  ),
  containers(
    "Script artifacts",
    "Scripts",
    "Each file that a Script writes to /out becomes media of the Thread. The Script runs card has a download link for each one.",
  ),
  containers(
    "Script Jobs",
    "Scripts",
    "The Long process Script runs longer than wallMs. It becomes a Job, the Turn parks, and progress lines appear. The Job completes with an artifact, or a cancel stops it.",
  ),
  {
    group: "Scripts",
    feature: "Network rules of a container",
    scenario: CONTAINERS,
    observable:
      "The Allowed host Script gets an answer from example.com. The Denied host Script gets HTTP 520, and stderr names example.org and the grant key.",
    verification: "Not verified in a Cloudflare account yet. The Worker tests cannot run a real container.",
  },
  knowledge(
    "Corpus ingestion",
    "Memory and Knowledge",
    "Ingest a document into the handbook. A document with a known id replaces the old text. The corpus is in the list of scope.knowledge.list.",
  ),
  knowledge(
    "Search",
    "Memory and Knowledge",
    "Search the handbook from the card and read the Passages with their docId, score and metadata. The search_handbook Tool returns the same Passages to the Agent, and the answer names the document.",
  ),
  knowledge(
    "Inline context",
    "Memory and Knowledge",
    "The notices corpus is in the Prompt under # Knowledge: notices. The Agent answers from it with no Tool call. A corpus over 32,000 code points fails the Turn.",
  ),
  knowledge(
    "Bulk Jobs",
    "Memory and Knowledge",
    "A bulk ingest of 40 documents returns a pending Job. The card shows its progress, and a completed document is searchable.",
  ),
  knowledge(
    "Deletion",
    "Memory and Knowledge",
    "Delete a document, and a search no longer finds it. Destroy a corpus, and it leaves the list of the Scope. Reset destroys each corpus and ingests the starting documents again.",
  ),
  vectors(
    "Vector and hybrid retrieval",
    "Search the guides with no shared word. The keyword search finds nothing. The vector and the hybrid searches find the document, and each Passage names its source. The search_guides Tool uses the hybrid settings of the Agent Spec.",
  ),
  vectors(
    "Vector index rebuild",
    "Remove the vectors from the index. A vector search finds nothing, and a keyword search still works. Rebuild writes the same opaque ids to the index again, and the vector search works again.",
  ),
  vectors(
    "Vector Scope isolation",
    "The second sample Scope has a guide with the same id. Each Scope finds only its own text, because the index keeps each Scope in its own namespace.",
  ),
  vectors(
    "Vector cleanup",
    "Reset destroys the guides of each Scope, which deletes their vectors from the index. pnpm run remove deletes the index that pnpm deploy created and keeps an index that you supplied.",
  ),
  lifecycle(
    "Scope suspension and resumption",
    "Scopes and credentials",
    "Suspend the Scope and run a prompt. The Turn parks with scope_suspended. Resume the Scope, and the Turn continues. The Threads and the credential stay.",
  ),
  lifecycle(
    "Scope destruction and the Destroy walk",
    "Scopes and credentials",
    "Destroy the Scope. The card follows the phase and the counts of the walk until only the tombstone stays. Each later operation gets scope.destroyed.",
  ),
  lifecycle(
    "A new Scope identity after a destroy",
    "Scopes and credentials",
    "Reset destroys the disposable Scope and moves to the next Scope id. The old id stays destroyed.",
  ),
  lifecycle(
    "Scope credentials",
    "Scopes and credentials",
    "Store a credential. The card shows its version and dates. No route, event or log returns the value.",
  ),
  lifecycle(
    "Provider test",
    "Scopes and credentials",
    "Test the credential. scope.providers.test makes one small Provider call and names the credential version.",
  ),
  lifecycle(
    "Credential revocation and fallback",
    "Scopes and credentials",
    "Revoke the credential. The next model Step runs under the Deployment profile, and step.started names the fallback. With the fallback off, the Turn fails.",
  ),
  {
    group: "Scopes and credentials",
    feature: "Key rotation",
    scenario: LIFECYCLE,
    observable:
      "pnpm rotate-key adds an active key. After a restart, Rewrap moves each credential to it, and the test passes after pnpm rotate-key --retire.",
    verification:
      "Setup tests rotate the key ring. Checked by hand with wrangler dev and the scripted Provider: a restart with the rotated ring, a rewrap of 1 credential, and a passed test after the old key was retired. No check ran with a real Provider or in a Cloudflare account.",
  },
  mcp(
    "Remote MCP servers",
    "Register a server. The Scope config gets the server as remote, and egress.mcpHosts permits its host only.",
    "Browser checks with a fake server. Checked by hand with wrangler dev and https://mcp.deepwiki.com/mcp, which has no credential.",
  ),
  mcp(
    "MCP tool discovery",
    "The Tools card shows the tools/list of the server with its catalogVersion, cacheScope and protocol era: modern for the 2026 protocol, legacy for an older one.",
    "Browser checks with a fake server. Checked by hand with wrangler dev and https://mcp.deepwiki.com/mcp, which has no credential. It listed 3 Tools in the legacy era with a private tool list.",
  ),
  mcp(
    "MCP Tools and the Permission Policy",
    "Without trustAnnotations, each call waits for an Approval. With trustAnnotations, the Policy allows a read-only Tool.",
    "Browser checks with a fake server. No real model called a real server yet.",
  ),
  mcp(
    "Static MCP credentials",
    "The header value is the Scope credential scope:mcp-remote. No route returns it. A revoked credential makes the next tool list fail.",
    "Not verified with a real server yet.",
  ),
  mcp(
    "OAuth Connections",
    "Connect opens the consent page. The callback stores the grant as the Connection mcp:remote of the User and sends the browser back. Disconnect removes it.",
    "Not verified with a real authorization server yet. pnpm deploy sets PLAYGROUND_ORIGIN with a second deploy, which did not run in a Cloudflare account yet.",
  ),
  mcp(
    "Connection Approvals",
    "A call without a grant parks the Turn on a connect Approval with the consent URL. OAuth completes it, and the call runs. A deny gives an error result.",
    "Not verified with a real authorization server yet.",
  ),
  mcp(
    "Failed and denied connections",
    "The Scope config refuses a private address. A wrong credential or a server that does not answer gives a failed tool list with the error code of the Framework.",
    "Browser checks with a fake server. The refused private address was checked by hand with wrangler dev.",
  ),
  turns("Capability grants", "Agents", `The longRunning grant gives the Turn ${String(MAX_STEPS)} Steps.`),
  shown("Streaming", "Threads", "The answer of the model appears while the model writes it."),
  shown("Cancellation on reset", "Threads", "Reset cancels a Turn that waits for an Approval."),
  shown("Deletion", "Threads", "Reset deletes the Thread of the scenario."),
  shown("REST operations and SSE", "HTTP and media", "The browser uses the routes of @karmi/http only."),
  shown("Errors", "HTTP and media", "A request without the access token gets a 401 answer."),
  forks(
    "Media uploads and downloads",
    "HTTP and media",
    "Upload a file with multipart HTTP and download its stored bytes.",
  ),
  forks("Thread and Scope media access", "HTTP and media", "A media route refuses a Thread outside this scenario."),
  schedules(
    "Delayed, timed and recurring Schedules",
    "Schedules and delivery",
    "Create a Schedule with each timing. The card lists it with the time of its next firing.",
  ),
  schedules(
    "Schedules of an Agent",
    "Schedules and delivery",
    "The scheduling grant gives the Agent the schedule Tool. Its Schedule appears in the same list.",
  ),
  schedules(
    "Schedule firing",
    "Schedules and delivery",
    "A schedule.fired event starts a Turn with the Event of the Schedule. A recurring Schedule stays in the list.",
  ),
  schedules(
    "Schedule cancellation",
    "Schedules and delivery",
    "Cancel removes the Schedule. Reset cancels each pending Schedule.",
  ),
  schedules(
    "External triggers",
    "Schedules and delivery",
    "The trigger route and the scheduled handler of the Worker send the same Event to the Thread.",
  ),
  schedules(
    "Offline delivery",
    "Schedules and delivery",
    "With the Subscriber detached, the sample inbox gets each completed Turn and each Approval request.",
  ),
  schedules(
    "Delivery and an attached Subscriber",
    "Schedules and delivery",
    "With the Subscriber attached, the inbox gets nothing. The detached page reads events without a stream.",
  ),
  shown("Provider selection", "Providers and MCP", "Setup selects one of five Providers. The header shows it."),
  providers(
    "Provider profiles and switching",
    "Providers and MCP",
    "Select a different profile and save. The same Thread runs its next Turn on the new Provider. Each model Step names its profile, adapter, model and Agent version.",
  ),
  providers(
    "Model capabilities of a profile",
    "Providers and MCP",
    "The Profiles card lists the Provider Tools that the Framework accepts on each profile. A grant on a different profile gets capability.unavailable.",
  ),
  providers(
    "Provider Tools",
    "Tools",
    "Grant web_search. Its call shows as server_tool events with the Provider, apart from the shop_hours call that the Harness runs.",
  ),
  providers(
    "Provider Tools and the Permission Policy",
    "Tools",
    "A deny rule removes web_search from the request. An ask rule gets policy.ask-on-provider-tool, and the Scope keeps the stored version.",
  ),
  providers(
    "AI Gateway",
    "Providers and MCP",
    "The gateway profile sends each call to the gateway. The Usage record has the gateway log id and no cost, because the gateway reports none.",
  ),
  {
    group: "Development and operations",
    feature: "Deployment, recovery and removal",
    scenario: "operations",
    observable: "Terminal commands deploy, retry and remove resources from one recorded Cloudflare account.",
    verification: "Command-boundary tests cover interruption, retry, account selection and external resources.",
  },
  ...SCENARIOS.filter((scenario) => !scenario.built && scenario.id !== "operations").map((scenario): CoverageRow => ({
    group: scenario.group,
    feature: scenario.title,
  })),
];
