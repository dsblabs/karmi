import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { lastMessage, reply } from "../src/testing/index";
import type { ThreadEvent } from "../src/index";
import { mirrored } from "./knowledge-fixtures";
import { clock, gate, karmi, provider, scope, secrets } from "./worker";

// Scope suspension and destruction end to end. The Scope `test` is destroyed by the last test in this file,
// so every test that needs a live Scope runs before it.

const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });
const pdf = "%PDF-1.7\n";

/** The rows left in one table of a Durable Object, read directly so an empty store can be proved empty. */
async function rows(namespace: DurableObjectNamespace, name: string, table: string): Promise<number> {
  const stub = namespace.get(namespace.idFromName(name));
  return runInDurableObject(
    stub,
    (_, state) => state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n,
  );
}

/** Everything the Thread logs after `seen`, up to the end of the Turn or its next park. */
async function rest(thread: ReturnType<typeof scope.thread>, seen: ThreadEvent[]): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  for await (const event of thread.subscribe({ after: seen.at(-1)!.seq })) {
    events.push(event);
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
  }
  return events;
}

it("parks a running Turn at the next Step boundary while the Scope is suspended, and resumes it", async () => {
  provider.script([[reply.toolCall("wait_gate", {}, "c1")], "Released"]);
  const thread = scope.thread({ agent: "approver", user: "guest-1", threadId: "suspend-park" });
  gate.open = false;
  const running = thread.send(message("Hold the line"));
  await expect.poll(async () => (await thread.status()).state).toBe("running");
  await scope.suspend();
  gate.open = true;
  const parked = await running;
  expect(parked).toContainEvent({ type: "tool.result", id: "c1", content: [{ type: "text", text: "released" }] });
  expect(parked).toContainEvent({ type: "turn.paused", reason: "scope_suspended" });
  await expect(thread.resume()).rejects.toMatchObject({ code: "scope.suspended" });

  await scope.resume();
  expect(await scope.status()).toMatchObject({ state: "active" });
  await thread.resume();
  const resumed = await rest(thread, parked);
  expect(resumed).toContainEvent({ type: "turn.resumed", reason: "resume" });
  expect(lastMessage(resumed)).toBe("Released");
});

it("empties a large R2 prefix across batches, carrying its progress from one to the next", async () => {
  const tenant = karmi.scope("bulk-destroy");
  const objects = 120;
  for (let i = 0; i < objects; i++) await env.KARMI_MEDIA.put(`bulk-destroy/media/bulk/${i}`, "x");
  const { operationId } = await tenant.destroy();
  await clock.advance(0);
  await expect.poll(async () => (await tenant.destroyStatus(operationId)).state).toBe("destroyed");
  expect((await tenant.destroyStatus(operationId)).progress.objects).toBe(objects);
  expect((await env.KARMI_MEDIA.list({ prefix: "bulk-destroy/" })).objects).toEqual([]);
});

it("empties every store in resumable batches, reports progress and leaves a tombstone nothing can resurrect", async () => {
  await scope.config.set({ ceilings: { longRunning: { maxSteps: 40 } } });
  await scope.credentials.put("tenant-key", "sk-tenant");
  await scope.agents.put({
    agentId: "destroy-parent",
    name: "Destroy parent",
    instructions: [],
    model: { id: "shared/destroy-parent" },
    delegates: ["concierge"],
    capabilities: { delegation: {} },
  });
  await scope.agents.connections.set("destroy-parent", "crm", { token: "t" });
  await scope.users.connections.set("alice", "crm", { token: "u" });

  // A Turn that writes a Memory, a Delegation child Thread, media, Knowledge with an external mirror, and
  // one object belonging to another Scope that the walk must leave alone.
  provider.script([
    [reply.toolCall("remember", { profile: { tier: "gold" }, note: "Likes window seats" }, "c0")],
    "Noted",
  ]);
  const remembering = scope.thread({ agent: "memo", user: "alice", threadId: "destroy-memory" });
  await remembering.send(message("I'm gold tier"));
  provider.script(({ request }) =>
    request.model === "destroy-parent"
      ? request.messages.some((m) => m.role === "toolResult")
        ? "Parent done"
        : reply.toolCall("delegate", { agent: "concierge", task: "Child task" }, "child-call")
      : "Child done",
  );
  const parent = scope.thread({ agent: "destroy-parent", user: "alice", threadId: "destroy-parent-thread" });
  await parent.send(message("Delegate this"));
  await expect.poll(async () => (await parent.events()).some((e) => e.type === "turn.completed")).toBe(true);
  // A Turn parked on an Approval: the walk must delete it rather than wait for an answer.
  provider.script([[reply.toolCall("book", { room: 7 }, "c2")], "Booked"]);
  const parked = scope.thread({ agent: "approver", user: "alice", threadId: "destroy-parked" });
  expect(await parked.send(message("Book 7"))).toContainEvent({ type: "turn.paused", reason: "approval" });
  const ref = await remembering.uploads.put(pdf);
  await env.KARMI_MEDIA.put("test/threads/destroy-memory/tool-output/1", "spill");
  // An object no live Thread owns, which only the prefix sweep can remove.
  await env.KARMI_MEDIA.put("test/media/orphan/1", "orphan");
  await env.KARMI_MEDIA.put("keeper/media/other/keep", "keep");
  await scope.knowledge("handbook").ingest([{ id: "refunds", text: "Refunds within 30 days." }], {
    retriever: "interrupted",
  });

  expect(await scope.users.memory.list()).toEqual(["alice"]);
  expect(await scope.knowledge.list()).toEqual(["handbook"]);
  expect(mirrored("test", "handbook")).toBe(true);
  expect(await scope.threads.list({ agent: "concierge", parent: parent.key })).toHaveLength(1);

  const { operationId } = await scope.destroy();
  expect((await scope.destroyStatus(operationId)).state).toBe("destroying");

  await clock.advance(0);
  await expect.poll(async () => (await scope.destroyStatus(operationId)).state).toBe("destroyed");
  const done = await scope.destroyStatus(operationId);
  expect(done.progress).toMatchObject({ phase: "done", memory: 1, knowledge: 1, skipped: 0 });
  // The Test kit's SecretsProvider is not karmi's own store, so the walk asks it to revoke what it holds.
  expect(done.externalCleanup).toEqual({ secrets: "revoked", credentials: ["tenant-key"] });
  expect(await secrets.describe({ scope: "test", ref: "scope:tenant-key" })).toMatchObject({
    revokedAt: expect.any(Number),
  });
  // The suspended Turn's Thread, the Memory Thread, the parked Thread, the Delegation parent and its child.
  expect(done.progress.threads).toBe(5);
  expect(done.progress.objects).toBeGreaterThanOrEqual(1);

  expect(await env.KARMI_MEDIA.get(ref.key)).toBeNull();
  expect((await env.KARMI_MEDIA.list({ prefix: "test/" })).objects).toEqual([]);
  expect(await env.KARMI_MEDIA.get("keeper/media/other/keep")).not.toBeNull();
  expect(mirrored("test", "handbook")).toBe(false);
  expect(await rows(env.KARMI_MEMORY, "test/memory/alice", "notes")).toBe(0);
  expect(await rows(env.KARMI_KNOWLEDGE!, "test/knowledge/handbook", "documents")).toBe(0);
  for (const table of [
    "threads",
    "thread_parents",
    "agent_specs",
    "connections",
    "user_connections",
    "knowledge_names",
    "memory_users",
    "provider_credentials",
    "mcp_grants",
  ])
    expect(await rows(env.KARMI_SCOPES, "test/config", table)).toBe(0);

  // The tombstone is all that is left, and it answers every later call.
  expect(await scope.status()).toEqual({ state: "destroyed", configRevision: 1 });
  const destroyed = { code: "scope.destroyed" };
  await expect(scope.config.set({})).rejects.toMatchObject(destroyed);
  await expect(scope.users.memory.list()).rejects.toMatchObject(destroyed);
  await expect(remembering.status()).rejects.toMatchObject({ code: "thread.deleted" });
  await expect(parked.status()).rejects.toMatchObject({ code: "thread.deleted" });
  const refused = await scope.thread({ agent: "memo", user: "alice", threadId: "after" }).send(message("Hi"));
  expect(refused).toContainEvent({ type: "turn.failed", reason: "scope.destroyed" });
  await expect(scope.destroy()).resolves.toEqual({ operationId });

  // Late alarms find the operation finished and change nothing.
  await clock.advance("1h");
  expect(await scope.destroyStatus(operationId)).toEqual(done);
  expect(await scope.status()).toEqual({ state: "destroyed", configRevision: 1 });
});
