import { AGENTS, ASSISTANT_PROMPTS } from "./assistant";
import { DISPATCH_PROMPTS, MAX_STEPS, TURNS } from "./dispatch";
import { FORKS, FORKS_PROMPT } from "./media-forks";
import type { ProviderSetup } from "./provider-options";
import { REFUND, REFUND_PROMPT } from "./refund";
import { REMINDER_PROMPTS, SCHEDULES } from "./reminders";
import { STOCKROOM, STOCKROOM_PROMPTS } from "./stockroom";

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
  notBuilt("provider-tools", "Tools", "Provider Tools"),
  notBuilt("compaction", "Threads", "Compaction and recovery"),
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
  notBuilt("delegation", "Delegation", "Child Threads and their Approvals"),
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
  notBuilt("memory", "Memory and Knowledge", "User Memory and document search", [
    "Vector retrieval needs a Cloudflare Vectorize index.",
  ]),
  notBuilt("scripts", "Scripts", "Isolate and container Scripts", [
    "Container Scripts need Docker locally, or a Cloudflare account with Containers.",
  ]),
  notBuilt("scopes", "Scopes and credentials", "Scope isolation, credentials and key rotation"),
  notBuilt("mcp", "Providers and MCP", "Provider switching, AI Gateway and remote MCP Tools", [
    "A remote MCP server.",
    "AI Gateway needs a Cloudflare account.",
  ]),
  notBuilt("http", "HTTP and media", "WebSocket and reconnects"),
  notBuilt("observability", "Observability", "Usage records, costs and logs"),
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

/** Adds the state for the current setup to a scenario. It makes no network call. */
export function viewScenario(scenario: Scenario, setup: ProviderSetup | undefined): ScenarioView {
  if (!scenario.built)
    return { ...scenario, status: "incomplete", reason: "This scenario is not built yet.", modelNotes: [] };
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
