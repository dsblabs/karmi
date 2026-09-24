import type { ThreadEvent } from "@karmi/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { containerRuns } from "../src/container-runs";
import { CONTAINER_LIMITS, CONTAINER_PROMPTS, CONTAINERS, SAMPLE_FILES } from "../src/containers";
import { USER } from "../src/runtimes";
import { SCENARIOS, viewScenario } from "../src/scenarios";
import { SCRIPTS } from "../src/scripts";
import { api as request, events } from "./client";
import { fakeContainer } from "./container-driver";
import { containerReplies } from "./script";
import { clock, karmi, provider } from "./worker";
import { setup, TOKEN } from "./worker-options";

const api = (method: string, path: string, body?: unknown) => request(TOKEN, method, path, body);
const PATH = `/api/scenarios/${CONTAINERS}`;

const mediaSchema = z.object({ id: z.string(), key: z.string(), name: z.string().optional(), bytes: z.number() });

const stateSchema = z.looseObject({
  threadKey: z.string(),
  threadId: z.string(),
  files: z.array(mediaSchema),
  grant: z.looseObject({ tier: z.literal("container"), egress: z.object({ allow: z.array(z.string()) }) }),
  runs: z.array(
    z.looseObject({
      callId: z.string(),
      state: z.enum(["running", "job", "done", "failed", "cancelled", "stopped"]),
      language: z.string(),
      files: z.array(z.string()),
      progress: z.string(),
      stdout: z.string().optional(),
      artifacts: z.array(mediaSchema),
    }),
  ),
});

const state = async () => stateSchema.parse(await (await api("GET", PATH)).json());
const prompt = (label: string) => {
  const found = CONTAINER_PROMPTS.find((item) => item.label === label);
  if (!found) throw new Error(`No prompt ${label}.`);
  return found.text;
};

async function until(key: string, done: (log: ThreadEvent[]) => boolean): Promise<ThreadEvent[]> {
  let log: ThreadEvent[] = [];
  await expect.poll(async () => done((log = await events(key))), { timeout: 10_000 }).toBe(true);
  return log;
}
const ended = (log: ThreadEvent[]) =>
  log.some((event) => event.type === "turn.completed" || event.type === "turn.failed");
const parked = (log: ThreadEvent[]) => log.some((event) => event.type === "turn.paused" && event.reason === "job");

/** Waits for the long Script to start, then moves the test clock past wallMs, thus the process becomes a Job. */
async function park(threadKey: string): Promise<void> {
  const started = (log: ThreadEvent[]) =>
    log.slice(log.findLastIndex((event) => event.type === "turn.started")).some((event) => event.type === "tool.call");
  await until(threadKey, started);
  await clock.advance(CONTAINER_LIMITS.wallMs);
  await until(threadKey, parked);
}

async function send(label: string) {
  const current = await state();
  const sent = await api("POST", `/threads/${current.threadKey}/turns`, {
    kind: "message",
    parts: [{ type: "text", text: prompt(label) }],
  });
  expect(sent.status).toBe(202);
  return { ...current, container: fakeContainer(`sample-a/${current.threadId}`) };
}

beforeEach(async () => {
  provider.script(containerReplies);
  await api("POST", `${PATH}/reset`);
});

describe("the container Scripts scenario", () => {
  it("is unavailable without a container runtime and tells how to get one", () => {
    const scenario = SCENARIOS.find((item) => item.id === CONTAINERS);
    if (!scenario) throw new Error("The container scenario is missing.");
    expect(viewScenario(scenario, setup, { hasLoader: true, containers: "docker" }).status).toBe("ready");
    expect(viewScenario(scenario, setup, { hasLoader: true })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("pnpm dev:containers"),
    });
  });

  it("gives the Thread its sample files", async () => {
    const { files } = await state();
    expect(files.map((file) => file.name)).toEqual(SAMPLE_FILES.map((file) => file.name));
    expect((await state()).files).toEqual(files);
  });

  it("runs a Python Script over the sample files and offers each artifact for download", async () => {
    const { threadKey, container } = await send("Python report");
    await until(threadKey, ended);
    // The model got the refs from the Fragment of the Agent, and the Workspace got the bytes in /in.
    expect(new TextDecoder().decode(container.files["sales.csv"])).toBe(SAMPLE_FILES[0]?.text);
    expect(container.allowed).toEqual(["example.com"]);
    expect(container.destroyed).toBe(true);
    const [run] = (await state()).runs;
    expect(run).toMatchObject({ state: "done", language: "python", files: ["sales.csv", "returns.csv"] });
    expect(run?.stdout).toContain("read sales.csv, returns.csv");
    expect(run?.artifacts.map((file) => file.name)).toEqual(["revenue.csv", "report.md"]);
    const report = run?.artifacts[1];
    const download = await api("GET", `${PATH}/media/${report?.id ?? ""}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("report.md");
    expect(await download.text()).toBe("Fake output: report.md\n");
  });

  it("turns a long process into a Job with progress, then completes the Job", async () => {
    const { threadKey, container } = await send("Long process");
    await park(threadKey);
    expect((await state()).runs[0]?.state).toBe("job");
    await clock.advance(5000);
    await expect.poll(async () => (await state()).runs[0]?.progress).toContain("Step 1");
    container.finish();
    await clock.advance(5000);
    await until(threadKey, ended);
    expect((await state()).runs[0]).toMatchObject({ state: "done", artifacts: [{ name: "long-run.txt" }] });
  });

  it("cancel stops the process of a Job and destroys the Workspace", async () => {
    const { threadKey, container } = await send("Long process");
    await park(threadKey);
    expect((await api("POST", `/threads/${threadKey}/cancel`)).status).toBeLessThan(300);
    await until(threadKey, ended);
    expect(container.signals[0]).toBe("SIGTERM");
    expect(container.destroyed).toBe(true);
    expect((await state()).runs[0]?.state).toBe("cancelled");
  });

  it("reset stops pending work and removes the artifacts, and no other scenario changes", async () => {
    const other = (await (await api("GET", `/api/scenarios/${SCRIPTS}`)).json()) as { threadKey: string };
    const done = await send("Python report");
    await until(done.threadKey, ended);
    const artifact = (await state()).runs[0]?.artifacts[0];
    const { threadKey, container } = await send("Long process");
    await park(threadKey);
    await api("POST", `${PATH}/reset`);
    expect(container.destroyed).toBe(true);
    const next = await state();
    expect(next.threadKey).not.toBe(threadKey);
    expect(next.runs).toEqual([]);
    expect(next.files.map((file) => file.id)).not.toEqual(done.files.map((file) => file.id));
    expect((await api("GET", `${PATH}/media/${artifact?.id ?? ""}`)).status).toBe(404);
    const after = (await (await api("GET", `/api/scenarios/${SCRIPTS}`)).json()) as { threadKey: string };
    expect(after.threadKey).toBe(other.threadKey);
  });

  it("a reset finishes the work of a reset that stopped after it deleted the Thread", async () => {
    const { threadId, threadKey } = await state();
    await karmi.scope("sample-a").thread({ agent: CONTAINERS, user: USER, threadId }).delete();
    expect((await api("POST", `${PATH}/reset`)).status).toBe(200);
    expect((await state()).threadKey).not.toBe(threadKey);
  });
});

describe("the container run view", () => {
  const call = (seq: number, type: string, data: Record<string, unknown>) =>
    ({ seq, turn: 1, at: 0, type, ...data }) as unknown as ThreadEvent;

  it("explains a denied host from the stderr line of the container proxy", () => {
    const result = {
      value: {
        stdout: "example.org answered HTTP 520\n",
        stderr: "Egress denied (520): example.org; grant capabilities.scripts.egress.allow.\n",
        exitCode: 0,
      },
      logs: [],
      toolCalls: [],
      artifacts: [],
    };
    const [run] = containerRuns("t", [
      call(1, "tool.call", { id: "a", name: "run_script", input: { code: "curl", language: "shell" } }),
      call(2, "tool.result", {
        id: "a",
        name: "run_script",
        isError: false,
        content: [{ type: "text", text: JSON.stringify(result) }],
      }),
    ]);
    expect(run).toMatchObject({ state: "done", denied: ["example.org"] });
    expect(run?.explanation).toContain("egress.allow");
  });
});
