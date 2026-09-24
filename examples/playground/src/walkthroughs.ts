// The terminal walkthrough of the development and operations scenario. The browser shows it, and
// test/walkthroughs.test.ts checks that each command names a script or a file that exists.

/** The id of the development and operations scenario. */
export const OPERATIONS = "operations";

/** The file that `pnpm record` writes and that `test/replay.test.ts` replays, relative to the Playground. */
export const RECORDING_FILE = "test/recordings/front-desk.jsonl";

/** The copy of `wrangler.jsonc` with one error, which the doctor walkthrough diagnoses. */
export const BROKEN_CONFIG = "walkthroughs/missing-migration.wrangler.jsonc";

/** One step of a terminal walkthrough. */
export interface WalkthroughStep {
  title: string;
  /** Why the operator runs the commands. */
  purpose: string;
  /** The commands, one on each line, to run in `examples/playground`. A line that starts with `#` is an instruction. */
  commands: string;
  /** The exact terminal output, when it does not change between runs. `test/walkthroughs.test.ts` compares it. */
  output?: string;
  /** What the operator sees and what it means. */
  expected: string;
}

const DOCTOR_CHECKS = `ok   compatibility: compatibility_date 2026-08-04 is at or above 2026-08-04.
ok   bindings: Every karmi binding is declared under its fixed name.
{durable-objects}
ok   capabilities: KARMI_LOADER is bound, so the isolate Script tier is available.
ok   capabilities: KARMI_SANDBOX is bound to KarmiSandbox with image ./node_modules/@karmi/sandbox-container/Dockerfile. Export KarmiSandbox and ContainerProxy, and match sandbox.image to this image.
--   vectorize: No KARMI_VECTORIZE binding, so no Vectorize index was inspected.
--   gateway: The manifest carries no createKarmi defaults, so gateways and deferral were not compared.
--   mcp: No manifest, so the MCP registration checklist was not built.
--   specs: The manifest lists no Agent Spec documents.`;

/** The steps of the development and operations walkthrough, in the order to run them. */
export const OPERATIONS_WALKTHROUGH: readonly WalkthroughStep[] = [
  {
    title: "Run the tests with the Test kit",
    purpose:
      "The Test kit of @karmi/core runs the Worker of the Playground in workerd. Its scripted Provider answers each model call, thus no test needs a credential or a network.",
    commands: "pnpm test",
    expected:
      "vitest runs each file in test/ and reports each one as passed. The command exits with code 0. A failed test prints the event that it expected and the events that it got.",
  },
  {
    title: "Run the tests of one scenario",
    purpose:
      "test/transports.test.ts uses the patterns of the REST, stream and socket tests of @karmi/http: it sends requests with SELF.fetch, reads the SSE records and sends WebSocket frames.",
    commands: "pnpm test test/transports.test.ts",
    expected: "vitest reports Test Files 1 passed (1). The command exits with code 0.",
  },
  {
    title: "Record the calls of a real Provider",
    purpose:
      "recordingProvider wraps the Provider of setup and keeps each request with the events of its answer. This step makes real model calls with the credential of pnpm setup.",
    commands: [
      "pnpm dev:record",
      "# Open the REST, SSE and WebSocket scenario and run one or two prompts.",
      "# Then, in a second terminal:",
      "pnpm record",
    ].join("\n"),
    expected: `The command prints Saved 1 call of the front desk Agent to ${RECORDING_FILE}. The number is the number of Turns that you ran. The file replaces the sample recording of the repository. git checkout ${RECORDING_FILE} restores it. The recording keeps the Prompt and the answers, but no credential.`,
  },
  {
    title: "Replay the recording",
    purpose:
      "fakeProvider.fromRecording serves the recorded events in call order. The test sends each recorded prompt to the front desk Agent again.",
    commands: "pnpm test test/replay.test.ts",
    expected:
      "vitest reports Test Files 1 passed (1). Each Turn gets the recorded answer, and no model call occurs. A recording of more Turns than the test sends fails with test.recording-exhausted.",
  },
  {
    title: "Check the configuration with karmi doctor",
    purpose:
      "karmi doctor reads wrangler.jsonc and the Worker entry before a deploy. It finds a configuration that stops a Deployment.",
    commands: "pnpm exec karmi doctor",
    output: DOCTOR_CHECKS.replace(
      "{durable-objects}",
      "ok   durable-objects: Every bound Durable Object class is exported and migrated as SQLite.",
    ),
    expected:
      "Each line is one finding. ok is a pass, and -- is a check with no input. The command exits with code 0. Local development needs no Vectorize index, thus the vectorize check has no input.",
  },
  {
    title: "Diagnose a configuration failure",
    purpose: `${BROKEN_CONFIG} is a copy of wrangler.jsonc without the migration karmi-v3. The command reads only the copy, thus wrangler.jsonc and .dev.vars do not change, and pnpm dev still starts.`,
    commands: `pnpm exec karmi doctor --config ${BROKEN_CONFIG}`,
    output: `${DOCTOR_CHECKS.replace(
      "{durable-objects}",
      "FAIL durable-objects: KnowledgeDO has no migration; add it to a migration's new_sqlite_classes.",
    )}

karmi doctor found problems that will break a deploy.`,
    expected:
      'The FAIL line names the class and the fix. The command exits with code 1. A deploy of this configuration fails, because Cloudflare cannot make the storage of KnowledgeDO. To fix it, add { "tag": "karmi-v3", "new_sqlite_classes": ["KnowledgeDO"] } to migrations.',
  },
  {
    title: "Deploy, retry and remove",
    purpose:
      "The deploy command creates the resources in your Cloudflare account and records them in a manifest. The remove command deletes only the resources of that manifest.",
    commands: [
      "pnpm deploy",
      "# After an interruption, run the command again with the deployment name that it printed:",
      "pnpm deploy karmi-playground-a1b2c3d4",
      "pnpm run remove karmi-playground-a1b2c3d4",
    ].join("\n"),
    expected:
      "pnpm deploy prints the workers.dev address of the Worker. A retry reads the manifest and continues the work that stopped. pnpm run remove prints Removed all resources owned by the deployment name, and one Preserved line for each resource that you supplied. If a resource remains, it lists the resource and exits with code 1. The README of the Playground tells each question and each option.",
  },
];
