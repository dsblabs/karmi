import { expect, it } from "vitest";
import { scope, provider, clock } from "./worker";
import { reply } from "../src/testing/index";
import { testContainer } from "./container-fixtures";

async function agent() {
  await scope.agents.put({
    agentId: "container",
    name: "Container",
    instructions: [],
    model: { id: "fake/test" },
    policy: [{ match: { tool: "*" }, effect: "allow" }],
    capabilities: { scripts: { tier: "container", limits: { wallMs: 1, jobMaxWallMs: 20000 }, egress: { allow: [] } } },
  });
}
const input: import("../src/thread-events").TurnInput = { kind: "message", parts: [{ type: "text", text: "Run" }] };

it("runs container Scripts through the Harness and destroys the Workspace at Turn end", async () => {
  await agent();
  provider.script([[reply.toolCall("run_script", { code: "success", language: "python" })], "done"]);
  const events = await scope.thread({ agent: "container", threadId: "container-sync" }).send(input);
  expect(events).toContainEvent({ type: "tool.result", name: "run_script", isError: false });
  expect(events).toContainEvent({ type: "usage.recorded", kind: "script", tier: "container" });
  expect(JSON.stringify(events)).toContain("test/media/container-sync/");
  expect(testContainer("test/container-sync").allowed).toEqual([]);
  expect(testContainer("test/container-sync").destroyed).toBe(true);
});

it("parks a long Script, polls its process, and runs the next Script only after completion", async () => {
  await agent();
  provider.script([
    [
      reply.toolCall("run_script", { code: "pending", language: "shell" }, "first"),
      reply.toolCall("run_script", { code: "success", language: "shell" }, "second"),
    ],
    "done",
  ]);
  const thread = scope.thread({ agent: "container", threadId: "container-job" });
  const events = await thread.send(input);
  expect(events).toContainEvent({ type: "turn.paused", reason: "job" });
  const driver = testContainer("test/container-job");
  expect(driver.starts).toEqual(["pending"]);
  expect(driver.alive).toBe(true);
  for (const [id] of driver.processes) driver.processes.set(id, { id, status: "completed", exitCode: 0 });
  await clock.advance(5000);
  await expect.poll(async () => JSON.stringify(await thread.events())).toContain('"type":"turn.completed"');
  expect(driver.starts).toEqual(["pending", "success"]);
  expect(driver.destroyed).toBe(true);
});

it("reports container_lost when a promoted process disappears", async () => {
  await agent();
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })], "recovered"]);
  const thread = scope.thread({ agent: "container", threadId: "container-lost" });
  await thread.send(input);
  testContainer("test/container-lost").processes.clear();
  await clock.advance(5000);
  await expect.poll(async () => JSON.stringify(await thread.events())).toContain("container_lost");
});

it("sends SIGTERM then SIGKILL and releases a parked Workspace on cancel", async () => {
  await agent();
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })]]);
  const thread = scope.thread({ agent: "container", threadId: "container-cancel" });
  await thread.send(input);
  await thread.cancel();
  const driver = testContainer("test/container-cancel");
  expect(driver.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(driver.destroyed).toBe(true);
});

it("materialises named media and rejects references from another Scope", async () => {
  await agent();
  const thread = scope.thread({ agent: "container", threadId: "container-input" });
  const ref = await thread.uploads.put("input");
  provider.script([
    [reply.toolCall("run_script", { code: "success", language: "shell", files: { "input.txt": ref } })],
    "done",
  ]);
  const events = await thread.send(input);
  expect(events).toContainEvent({ type: "tool.result", name: "run_script", isError: false });
  expect(new TextDecoder().decode(testContainer("test/container-input").files["input.txt"])).toBe("input");
  provider.script([
    [
      reply.toolCall("run_script", {
        code: "success",
        language: "shell",
        files: { "input.txt": { ...ref, key: ref.key.replace("test/", "other/") } },
      }),
    ],
    "done",
  ]);
  expect(JSON.stringify(await thread.send(input))).toContain("Script files must reference media of this Thread");
});

it("kills a Job that exceeds its wall deadline", async () => {
  await agent();
  const thread = scope.thread({ agent: "container", threadId: "container-timeout" });
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })], "done"]);
  await thread.send(input);
  await clock.advance(21000);
  await expect.poll(async () => JSON.stringify(await thread.events())).toContain("jobMaxWallMs exceeded");
  expect(testContainer("test/container-timeout").signals).toEqual(["SIGTERM", "SIGKILL"]);
});

it("ends a cancelled Turn when the container destroy fails, and retries the destroy later", async () => {
  await agent();
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })]]);
  const thread = scope.thread({ agent: "container", threadId: "container-destroy-retry" });
  await thread.send(input);
  const driver = testContainer("test/container-destroy-retry");
  driver.failDestroys = 1;
  await thread.cancel();
  expect(await thread.events()).toContainEvent({ type: "turn.failed", reason: "cancelled" });
  expect(driver.destroyed).toBe(false);
  await clock.advance(30000);
  await expect.poll(() => driver.destroyed).toBe(true);
  await thread.delete();
});

it("deletes a Thread only after its container destroy succeeds, and then frees the Scope slot", async () => {
  await scope.config.set({ ceilings: { scripts: { maxContainers: 1 } } });
  await agent();
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })]]);
  const first = scope.thread({ agent: "container", threadId: "container-delete-retry" });
  await first.send(input);
  const driver = testContainer("test/container-delete-retry");
  driver.failDestroys = 2;
  await first.cancel();
  await first.delete();
  expect(driver.destroyed).toBe(false);
  // The cleanup runs as an alarm. Each pass of the poll moves the clock past its next retry.
  await expect
    .poll(async () => {
      await clock.advance(30000);
      return driver.destroyed;
    })
    .toBe(true);
  const second = scope.thread({ agent: "container", threadId: "container-delete-next" });
  provider.script([[reply.toolCall("run_script", { code: "success", language: "shell" })], "done"]);
  await expect
    .poll(async () => JSON.stringify(await second.send(input)), { timeout: 5000 })
    .not.toContain("maxContainers ceiling");
  await scope.config.set({ ceilings: {} });
});

it("enforces the shared Scope container ceiling and frees capacity after cancel", async () => {
  await scope.config.set({ ceilings: { scripts: { maxContainers: 1 } } });
  await agent();
  const first = scope.thread({ agent: "container", threadId: "container-cap-first" });
  provider.script([[reply.toolCall("run_script", { code: "pending", language: "shell" })]]);
  await first.send(input);
  const second = scope.thread({ agent: "container", threadId: "container-cap-second" });
  provider.script([[reply.toolCall("run_script", { code: "success", language: "shell" })], "done"]);
  expect(JSON.stringify(await second.send(input))).toContain("maxContainers ceiling");
  expect(testContainer("test/container-cap-second").starts).toEqual([]);
  await first.cancel();
  provider.script([[reply.toolCall("run_script", { code: "success", language: "shell" })], "done"]);
  expect(await second.send(input)).toContainEvent({ type: "tool.result", name: "run_script", isError: false });
});
