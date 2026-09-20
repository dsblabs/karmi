import type { ProviderSetup } from "./provider-options";
import { REFUND, REFUND_PROMPT } from "./refund";

const CODE = "https://github.com/dsblabs/karmi/blob/main/examples/playground";

/** A model feature that a scenario needs. */
export type ModelFeature = "toolCalls";

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
  /** The prompt that the scenario suggests. */
  prompt?: string;
  /** The link to the example code. */
  code?: string;
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
    prompt: REFUND_PROMPT,
    code: `${CODE}/src/refund.ts`,
  },
  notBuilt("agents", "Agents", "Agent Specs, Prompts and Capability ceilings"),
  notBuilt("tools", "Tools", "Hooks, Skills, deferred Tools and Provider Tools"),
  notBuilt("threads", "Threads", "Steering, cancellation, budgets, Jobs, Compaction and forks"),
  notBuilt("delegation", "Delegation", "Child Threads and their Approvals"),
  notBuilt("schedules", "Schedules and delivery", "Schedules, external triggers and offline delivery"),
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
  notBuilt("http", "HTTP and media", "WebSocket, reconnects, uploads and downloads"),
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
  const modelNotes =
    scenario.needs.includes("toolCalls") && !setup.option.toolCalls
      ? [
          `This scenario needs a model that supports Tool calls. The Playground cannot check that for ${setup.model}. A model without Tool calls answers in text only, and no Approval appears.`,
        ]
      : [];
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

const shown = (feature: string, group: string, observable: string): CoverageRow => ({
  group,
  feature,
  scenario: REFUND,
  observable,
  verification: "Worker tests with the scripted Provider, and browser checks.",
});

/** The delivered feature coverage. A row without a scenario is a feature that no scenario shows yet. */
export const COVERAGE: readonly CoverageRow[] = [
  shown("Instructions and model selection", "Agents", "The Agent runs on the model that setup selected."),
  shown("Tool inputs and results", "Tools", "The event log shows each Tool call and its result."),
  shown("Annotations and Permission Policy", "Tools", "The read-only lookup runs. The refund waits for an Approval."),
  shown("Approvals", "Threads", "Allow changes the sample order. Deny leaves it unchanged."),
  shown("Streaming", "Threads", "The answer of the model appears while the model writes it."),
  shown("Cancellation", "Threads", "Reset cancels a Turn that waits for an Approval."),
  shown("Deletion", "Threads", "Reset deletes the Thread of the scenario."),
  shown("REST operations and SSE", "HTTP and media", "The browser uses the routes of @karmi/http only."),
  shown("Errors", "HTTP and media", "A request without the access token gets a 401 answer."),
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
