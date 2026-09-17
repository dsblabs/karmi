import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import * as z from "zod/mini";
import { AgentSpecSchema, AGENT_SPEC_DEFAULTS, type NormalizedAgentSpec } from "./agent-spec";
import { KARMI_BINDING_NAMES } from "./bindings";
import { COMPATIBILITY_DATE_FLOOR } from "./compat";
import { KarmiError } from "./errors";
import { OAUTH_CALLBACK_PATH, preRegistrationForUrl } from "./mcp-auth";
import { BUILT_IN_TOOL_NAMES } from "./names";
import { checkVectorizeIndex } from "./vector-doctor";
import type { EmbeddingIndex } from "./vector-store";
import { firstIssue, pointer } from "./validate";

// The `karmi doctor` checks. Every function here is pure over plain data, so the bin owns all file and
// network access and the checks are tested without either.

/** How one doctor check turned out. `skip` means the check had nothing to run against. */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/** One outcome of one doctor check. A check may report several. */
export interface Finding {
  /** The check's stable name, such as `compatibility` or `bindings`. */
  check: string;
  /** Whether this finding blocks a deploy, warns, confirms, or records that the check had no input. */
  status: CheckStatus;
  /** One sentence naming what is wrong and what to do about it. */
  message: string;
}

const pass = (check: string, message: string): Finding => ({ check, status: "pass", message });
const warn = (check: string, message: string): Finding => ({ check, status: "warn", message });
const fail = (check: string, message: string): Finding => ({ check, status: "fail", message });
const skip = (check: string, message: string): Finding => ({ check, status: "skip", message });

const BindingSchema = z.object({ binding: z.string() });
const WranglerSchema = z.object({
  main: z.optional(z.string()),
  account_id: z.optional(z.string()),
  compatibility_date: z.optional(z.string()),
  compatibility_flags: z.optional(z.array(z.string())),
  durable_objects: z.optional(z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) })),
  migrations: z.optional(
    z.array(
      z.object({
        tag: z.string(),
        new_classes: z.optional(z.array(z.string())),
        new_sqlite_classes: z.optional(z.array(z.string())),
      }),
    ),
  ),
  r2_buckets: z.optional(z.array(BindingSchema)),
  queues: z.optional(
    z.object({
      producers: z.optional(z.array(z.object({ binding: z.string(), queue: z.string() }))),
      consumers: z.optional(z.array(z.object({ queue: z.string(), dead_letter_queue: z.optional(z.string()) }))),
    }),
  ),
  worker_loaders: z.optional(z.array(BindingSchema)),
  containers: z.optional(z.array(z.unknown())),
  vectorize: z.optional(z.array(z.object({ binding: z.string(), index_name: z.string() }))),
  ai: z.optional(BindingSchema),
});
/** A wrangler configuration, as far as the doctor checks read it. */
export type WranglerConfig = z.infer<typeof WranglerSchema>;

/**
 * Reads the text of a `wrangler.jsonc` or `wrangler.json`. Comments and trailing commas are allowed.
 * Throws `config.invalid` when the text is not JSON or a field karmi reads is malformed.
 */
export function decodeWranglerConfig(source: string): WranglerConfig {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    throw new KarmiError(
      "config.invalid",
      `The wrangler config is not JSON: ${errors.map((issue) => printParseErrorCode(issue.error)).join(", ")}.`,
    );
  const result = z.safeParse(WranglerSchema, value);
  if (result.success) return result.data;
  const issue = firstIssue(result.error);
  throw new KarmiError(
    "config.invalid",
    `The wrangler config is invalid at "${pointer(issue.path)}": ${issue.message}`,
  );
}

const named = z.array(z.object({ name: z.string() }));
// Only the parts of `catalogue.describe()` that reference resolution needs. The rest of the document is
// accepted and dropped.
const ManifestSchema = z.object({
  /** `karmi.catalogue.describe()`, which Agent Spec references are resolved against. */
  catalogue: z.optional(
    z.object({
      tools: z.optional(named),
      fragments: z.optional(named),
      skills: z.optional(z.array(z.object({ name: z.string(), tools: z.optional(z.array(z.string())) }))),
      retrievers: z.optional(named),
      hooks: z.optional(named),
      agents: z.optional(z.array(z.object({ agentId: z.string() }))),
    }),
  ),
  /** The Agent Specs to check, keyed by where each one came from. */
  specs: z.optional(z.record(z.string(), z.unknown())),
  /** `createKarmi({ defaults })`, which the gateway and MCP checks read. */
  defaults: z.optional(
    z.object({
      providers: z.optional(z.record(z.string(), z.object({ gateway: z.optional(z.unknown()) }))),
      mcp: z.optional(
        z.object({
          servers: z.optional(z.record(z.string(), z.object({ url: z.string(), auth: z.optional(z.unknown()) }))),
        }),
      ),
    }),
  ),
  /** `createKarmi({ oauth }).origin`, so the MCP checklist can print the exact callback URL. */
  origin: z.optional(z.string()),
});

/**
 * What a Deployment defines in code, for the checks a wrangler config cannot answer. Every field is
 * optional, and a check whose input is absent reports `skip` rather than failing.
 */
export type DoctorManifest = z.infer<typeof ManifestSchema>;
/** The Catalogue as a manifest carries it: the names each kind defines. */
type DoctorCatalogue = NonNullable<DoctorManifest["catalogue"]>;

/** Reads a doctor manifest document. Throws `config.invalid` when it is malformed. */
export function decodeDoctorManifest(value: unknown): DoctorManifest {
  const result = z.safeParse(ManifestSchema, value);
  if (result.success) return result.data;
  const issue = firstIssue(result.error);
  throw new KarmiError(
    "config.invalid",
    `The doctor manifest is invalid at "${pointer(issue.path)}": ${issue.message}`,
  );
}

/** Everything `runChecks` reads. The caller does the file reading, so the checks stay free of I/O. */
export interface DoctorInput {
  /** The parsed wrangler configuration. */
  config: WranglerConfig;
  /** The source of the Worker entry module named by `main`. Absent skips the Durable Object re-export check. */
  entry?: string;
  /** What the Deployment defines in code. Absent skips the gateway, MCP and Agent Spec checks. */
  manifest?: DoctorManifest;
  /** Cloudflare API credentials. Absent skips the Vectorize check. */
  cloudflare?: { accountId: string; apiToken: string };
  /** The embedding index a bound Vectorize index must match. Defaults to 1024 dimensions and `cosine`. */
  index?: Pick<EmbeddingIndex, "dims" | "metric">;
  /** The Vectorize binding to inspect. Defaults to `KARMI_VECTORIZE`, the built-in Vector store's own. */
  vectorizeBinding?: string;
  /** The transport the Vectorize check calls the management API with. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks `compatibility_date` against the floor karmi runs on, and the recommended compatibility flags. */
export function checkCompatibility(config: WranglerConfig): Finding[] {
  const date = config.compatibility_date;
  if (date === undefined || !DATE.test(date))
    return [fail("compatibility", `Set compatibility_date to ${COMPATIBILITY_DATE_FLOOR} or later.`)];
  // ISO dates compare correctly as strings, so no date parsing is needed.
  if (date < COMPATIBILITY_DATE_FLOOR)
    return [
      fail(
        "compatibility",
        `compatibility_date ${date} is below karmi's floor ${COMPATIBILITY_DATE_FLOOR}; raise it (ADR-0002).`,
      ),
    ];
  const findings = [pass("compatibility", `compatibility_date ${date} is at or above ${COMPATIBILITY_DATE_FLOOR}.`)];
  if (!config.compatibility_flags?.includes("global_fetch_strictly_public"))
    findings.push(
      warn(
        "compatibility",
        'Add the compatibility flag "global_fetch_strictly_public" so every outbound fetch is SSRF-hardened.',
      ),
    );
  return findings;
}

const REQUIRED_DURABLE_OBJECTS = ["KARMI_THREADS", "KARMI_SCOPES", "KARMI_MEMORY"];

/** Every binding name the wrangler config declares, across the binding kinds karmi uses. */
function declaredBindings(config: WranglerConfig): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const { name } of config.durable_objects?.bindings ?? []) bindings.set(name, "durable object");
  for (const { binding } of config.r2_buckets ?? []) bindings.set(binding, "r2 bucket");
  for (const { binding } of config.queues?.producers ?? []) bindings.set(binding, "queue producer");
  for (const { binding } of config.worker_loaders ?? []) bindings.set(binding, "worker loader");
  for (const { binding } of config.vectorize ?? []) bindings.set(binding, "vectorize index");
  if (config.ai) bindings.set(config.ai.binding, "workers ai");
  return bindings;
}

/** Checks that the required `KARMI_*` bindings exist, that no `KARMI_*` name is a typo, and that the Queue pairs up. */
export function checkBindings(config: WranglerConfig): Finding[] {
  const bindings = declaredBindings(config);
  const findings: Finding[] = [];
  for (const name of REQUIRED_DURABLE_OBJECTS)
    if (bindings.get(name) !== "durable object")
      findings.push(
        fail("bindings", `Missing Durable Object binding ${name}; copy @karmi/core/wrangler.baseline.jsonc.`),
      );
  for (const [name, kind] of bindings)
    if (name.startsWith("KARMI_") && !KARMI_BINDING_NAMES.some((known) => known === name))
      findings.push(warn("bindings", `The ${kind} binding ${name} is not a karmi binding name and is ignored.`));
  const producer = config.queues?.producers?.find((entry) => entry.binding === "KARMI_QUEUE");
  if (producer && !config.queues?.consumers?.some((entry) => entry.queue === producer.queue))
    findings.push(
      warn("bindings", `The queue "${producer.queue}" has no consumer, so Deliverers and Usage records never run.`),
    );
  if (!bindings.has("KARMI_MEDIA"))
    findings.push(warn("bindings", "Without an R2 bucket on KARMI_MEDIA, media and spilled Tool output are refused."));
  if (findings.length === 0) findings.push(pass("bindings", "Every karmi binding is declared under its fixed name."));
  return findings;
}

const EXPORT_LIST = /export\s+(?:const\s*)?\{([^}]*)\}/g;
const EXPORT_DECLARATION = /export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

/** The names a module's source exports, read without parsing it. */
export function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const [, list] of source.matchAll(EXPORT_LIST))
    for (const entry of (list ?? "").split(",")) {
      // `A as B`, `A: B` and a bare `A` all export the last identifier in the entry.
      const parts = entry.trim().split(/\s+as\s+|:/);
      const name = parts[parts.length - 1]?.trim();
      if (name) names.add(name);
    }
  for (const [, name] of source.matchAll(EXPORT_DECLARATION)) if (name) names.add(name);
  return names;
}

/**
 * Checks that every Durable Object class the config binds is a named export of the Worker entry and is
 * migrated as a SQLite class.
 */
export function checkDurableObjects(config: WranglerConfig, entry: string | undefined): Finding[] {
  const classes = new Set((config.durable_objects?.bindings ?? []).map((binding) => binding.class_name));
  if (classes.size === 0) return [skip("durable-objects", "The config binds no Durable Object classes.")];
  const findings: Finding[] = [];
  const sqlite = new Set((config.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? []));
  const plain = new Set((config.migrations ?? []).flatMap((migration) => migration.new_classes ?? []));
  for (const name of classes) {
    if (plain.has(name))
      findings.push(fail("durable-objects", `${name} is migrated with new_classes; karmi needs new_sqlite_classes.`));
    else if (!sqlite.has(name))
      findings.push(fail("durable-objects", `${name} has no migration; add it to a migration's new_sqlite_classes.`));
  }
  if (entry === undefined)
    findings.push(
      skip("durable-objects", `Could not read ${config.main ?? "the Worker entry"}; re-exports unchecked.`),
    );
  else {
    const exported = exportedNames(entry);
    for (const name of classes)
      if (!exported.has(name))
        findings.push(
          fail("durable-objects", `${config.main} does not export ${name}; re-export it from karmi.durableObjects.`),
        );
  }
  if (findings.length === 0)
    findings.push(pass("durable-objects", "Every bound Durable Object class is exported and migrated as SQLite."));
  return findings;
}

/** Reports which optional runtimes the config makes available: isolate Scripts and the container tier. */
export function checkCapabilities(config: WranglerConfig): Finding[] {
  const loader = (config.worker_loaders ?? []).some((entry) => entry.binding === "KARMI_LOADER");
  const containers = (config.containers ?? []).length > 0;
  return [
    loader
      ? pass("capabilities", "KARMI_LOADER is bound, so the isolate Script tier is available.")
      : skip(
          "capabilities",
          'No KARMI_LOADER binding: an Agent granting capabilities.scripts { tier: "isolate" } fails.',
        ),
    containers
      ? pass("capabilities", "A container is configured, so the container Script tier is available.")
      : skip(
          "capabilities",
          'No container is configured: an Agent granting capabilities.scripts { tier: "container" } fails.',
        ),
  ];
}

/** Checks a bound Vectorize index's dimensions, metric and metadata indexes through the management API. */
export async function checkVectorize(input: DoctorInput): Promise<Finding[]> {
  const binding = input.vectorizeBinding ?? "KARMI_VECTORIZE";
  const bound = (input.config.vectorize ?? []).find((entry) => entry.binding === binding);
  if (!bound) return [skip("vectorize", `No ${binding} binding, so no Vectorize index was inspected.`)];
  const accountId = input.cloudflare?.accountId ?? input.config.account_id;
  const apiToken = input.cloudflare?.apiToken;
  if (!accountId || !apiToken)
    return [
      skip("vectorize", "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to inspect the bound Vectorize index."),
    ];
  const index = input.index ?? { dims: 1024, metric: "cosine" };
  try {
    await checkVectorizeIndex(bound.index_name, index, { accountId, apiToken }, input.fetch);
  } catch (error) {
    return [fail("vectorize", error instanceof KarmiError ? error.message : String(error))];
  }
  return [
    pass("vectorize", `Vectorize ${bound.index_name} is ${index.dims}/${index.metric} with both metadata indexes.`),
  ];
}

/**
 * Warns when a Provider profile runs through an AI Gateway while an Agent defers its Tools. Only
 * Cloudflare AI Gateway is known to pass the deferred-loading request bodies through unchanged.
 */
export function checkGatewayDefer(manifest: DoctorManifest | undefined): Finding[] {
  const profiles = Object.entries(manifest?.defaults?.providers ?? {}).filter(([, config]) => config.gateway);
  const specs = manifest?.specs;
  if (!manifest?.defaults || !specs)
    return [
      skip(
        "gateway",
        `The manifest carries no ${manifest?.defaults ? "Agent Spec" : "createKarmi defaults"}, so gateways and deferral were not compared.`,
      ),
    ];
  if (profiles.length === 0) return [pass("gateway", "No Provider profile runs through a gateway.")];
  const deferring = Object.entries(specs).filter(([, spec]) => defersTools(spec));
  if (deferring.length === 0) return [pass("gateway", "A gateway is configured and no Agent Spec defers its Tools.")];
  return [
    warn(
      "gateway",
      `The profiles ${profiles.map(([name]) => name).join(", ")} run through a gateway while ${deferring
        .map(([source]) => source)
        .join(", ")} defer Tools; only Cloudflare AI Gateway is verified to pass deferred loading through.`,
    ),
  ];
}

const DeferSchema = z.object({
  context: z.optional(z.object({ tools: z.optional(z.object({ defer: z.optional(z.string()) })) })),
});

function defersTools(spec: unknown): boolean {
  const parsed = z.safeParse(DeferSchema, spec);
  const defer = parsed.success ? parsed.data.context?.tools?.defer : undefined;
  return (defer ?? AGENT_SPEC_DEFAULTS.context.tools.defer) !== "never";
}

const OAuthSchema = z.object({ type: z.string(), client: z.optional(z.object({ id: z.string() })) });

/** Lists the MCP servers whose authorization server only takes a client registered by hand, with the callback URL. */
export function checkMcp(manifest: DoctorManifest | undefined): Finding[] {
  const servers = Object.entries(manifest?.defaults?.mcp?.servers ?? {});
  if (!manifest?.defaults) return [skip("mcp", "No manifest, so the MCP registration checklist was not built.")];
  const oauth = servers.flatMap(([id, server]) => {
    const auth = z.safeParse(OAuthSchema, server.auth);
    return auth.success && auth.data.type === "oauth" ? [{ id, url: server.url, client: auth.data.client }] : [];
  });
  if (oauth.length === 0) return [pass("mcp", "No MCP server uses OAuth, so no client registration is needed.")];
  const callback = manifest.origin ? `${manifest.origin}${OAUTH_CALLBACK_PATH}` : undefined;
  const findings: Finding[] = [];
  if (!callback)
    findings.push(warn("mcp", "Set createKarmi({ oauth: { origin } }); no OAuth server can be used without it."));
  for (const server of oauth) {
    const known = preRegistrationForUrl(server.url);
    if (!known || server.client) continue;
    const secret = known.secretRequired ? " It issues a client secret, which goes in auth.client.secret." : "";
    findings.push(
      warn(
        "mcp",
        `MCP server "${server.id}" is a ${known.name} server, which takes only a pre-registered client. Register one at ${known.registerAt} with the callback URL ${callback ?? `<origin>${OAUTH_CALLBACK_PATH}`}, then set auth.client.id.${secret} ${known.notes ?? ""}`.trim(),
      ),
    );
  }
  if (findings.length === 0)
    findings.push(pass("mcp", `Every OAuth MCP server can register itself; the callback URL is ${callback}.`));
  return findings;
}

/** Checks each Agent Spec's shape, then that every Catalogue item it names exists. */
export function checkSpecs(manifest: DoctorManifest | undefined): Finding[] {
  const specs = Object.entries(manifest?.specs ?? {});
  if (specs.length === 0) return [skip("specs", "The manifest lists no Agent Spec documents.")];
  const findings: Finding[] = [];
  for (const [source, document] of specs) {
    const parsed = z.safeParse(AgentSpecSchema, document);
    if (!parsed.success) {
      const issue = firstIssue(parsed.error);
      findings.push(fail("specs", `${source} is not a valid Agent Spec at "${pointer(issue.path)}": ${issue.message}`));
      continue;
    }
    if (!manifest?.catalogue) continue;
    for (const dangling of danglingReferences(parsed.data, manifest.catalogue))
      findings.push(fail("specs", `${source} references ${dangling}, which the Catalogue does not define.`));
  }
  if (!manifest?.catalogue)
    findings.push(skip("specs", "The manifest carries no Catalogue description, so references were not resolved."));
  if (findings.length === 0) findings.push(pass("specs", `Every Agent Spec resolves against the Catalogue.`));
  return findings;
}

/** One Catalogue item an Agent Spec names, by the kind of item it is. */
interface SpecReference {
  kind: "tool" | "fragment" | "skill" | "retriever" | "hook" | "agent";
  name: string;
}

/**
 * Every Catalogue item an Agent Spec names. MCP references resolve against a Scope's registry rather than
 * the Catalogue, so they are left out.
 */
function specReferences(spec: NormalizedAgentSpec): SpecReference[] {
  const as =
    (kind: SpecReference["kind"]) =>
    (name: string): SpecReference => ({ kind, name });
  return [
    ...(spec.tools ?? [])
      .map((ref) => ref.name)
      .filter((name) => !name.startsWith("mcp:"))
      .map(as("tool")),
    ...(spec.skills ?? []).map((ref) => ref.name).map(as("skill")),
    ...(spec.delegates ?? []).map(as("agent")),
    ...Object.values(spec.hooks ?? {}).flatMap((names) => (names ?? []).map(as("hook"))),
    ...spec.instructions.flatMap((entry) => ("fragment" in entry ? [entry.fragment] : [])).map(as("fragment")),
    ...(spec.knowledge ?? [])
      .flatMap((ref) => (ref.retriever === undefined ? [] : [ref.retriever]))
      .map(as("retriever")),
  ];
}

/** The references of `spec` that `catalogue` does not define, each as `<kind> "<name>"`. */
function danglingReferences(spec: NormalizedAgentSpec, catalogue: DoctorCatalogue): string[] {
  const names = (items: readonly { name: string }[] = []) => new Set(items.map((item) => item.name));
  const skills = catalogue.skills ?? [];
  const known: Record<SpecReference["kind"], Set<string>> = {
    tool: new Set([...names(catalogue.tools), ...BUILT_IN_TOOL_NAMES, ...skills.flatMap((skill) => skill.tools ?? [])]),
    fragment: names(catalogue.fragments),
    skill: names(skills),
    retriever: new Set([...names(catalogue.retrievers), "fts5"]),
    hook: names(catalogue.hooks),
    agent: new Set((catalogue.agents ?? []).map((agent) => agent.agentId)),
  };
  return specReferences(spec)
    .filter((ref) => !known[ref.kind].has(ref.name))
    .map((ref) => `${ref.kind} "${ref.name}"`);
}

/** Runs every doctor check and returns the findings in check order. */
export async function runChecks(input: DoctorInput): Promise<Finding[]> {
  return [
    ...checkCompatibility(input.config),
    ...checkBindings(input.config),
    ...checkDurableObjects(input.config, input.entry),
    ...checkCapabilities(input.config),
    ...(await checkVectorize(input)),
    ...checkGatewayDefer(input.manifest),
    ...checkMcp(input.manifest),
    ...checkSpecs(input.manifest),
  ];
}

const MARKS: Record<CheckStatus, string> = { pass: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };

/** The findings as lines a terminal can show, one per finding. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((finding) => `${MARKS[finding.status]} ${finding.check}: ${finding.message}`).join("\n");
}

/** Whether any finding failed, which is what `karmi doctor` exits non-zero on. */
export function hasFailure(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.status === "fail");
}
