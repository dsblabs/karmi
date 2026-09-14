import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CloudflareIsolateSandbox, type SandboxRequest, validateAgentSpec, assembleCatalogue } from "../src/index";
import { resolveBindings } from "../src/bindings";

function sandbox() {
  const loader = resolveBindings(env).KARMI_LOADER;
  if (!loader) throw new Error("Real Worker Loader required");
  return new CloudflareIsolateSandbox(loader);
}
const request = (code: string): SandboxRequest => ({
  code,
  tools: [],
  limits: { cpuMs: 100, wallMs: 1000, maxToolCalls: 2 },
  signal: new AbortController().signal,
  call: async () => {
    throw new Error("No Tools granted");
  },
  result: async () => {
    throw new Error("No results");
  },
});

it("round-trips binary values through the real Worker bridge", async () => {
  const result = await sandbox().run({
    ...request("export default async () => await tools.bytes({value:new Uint8Array([1,2,255])})"),
    tools: ["bytes"],
    call: async (_name, input) => {
      expect(input).toEqual({ value: new Uint8Array([1, 2, 255]) });
      return { callId: "test:1", value: new Uint8Array([4, 5, 6]), isError: false };
    },
  });
  expect(result.value).toEqual(new Uint8Array([4, 5, 6]));
  expect(result.artifacts).toEqual([]);
});

it("cancels a running script and revokes its Tool bridge", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = sandbox().run({
    ...request("export default async () => await tools.wait({})"),
    tools: ["wait"],
    signal: controller.signal,
    call: async (_name, _input, signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { callId: "test:1", value: "finished", isError: false };
    },
  });
  await called;
  controller.abort(new Error("cancelled"));
  const result = await running;
  expect(result.error?.message).toBe("cancelled");
});

it("reports missing Loader availability during Spec validation", () => {
  const result = validateAgentSpec(
    {
      agentId: "scripts",
      name: "Scripts",
      instructions: [],
      model: { id: "fake/test" },
      capabilities: { scripts: { tier: "isolate" } },
    },
    assembleCatalogue({}),
    {
      agents: [],
      config: { providers: { default: { adapter: "fake", models: ["*"] } } },
      loaderAvailable: false,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "capability.unavailable", path: "/capabilities/scripts" }),
    );
});

it.skip("enforces cpuMs on Cloudflare (local workerd does not enforce CPU limits)", async () => {
  const result = await sandbox().run({
    ...request("export default () => { let n = 0; for (let i = 0; i < 100000000; i++) n += Math.sqrt(i); return n; }"),
    limits: { cpuMs: 1, wallMs: 2000, maxToolCalls: 1 },
  });
  expect(result.error?.message).toBe("limit_exceeded: cpuMs");
});
