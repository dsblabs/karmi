import { describe, expect, it } from "vitest";
import { KarmiError, SpecInvalidError, type AgentSpec } from "../src/index.js";
import { karmi } from "./worker.js";

// Storage is shared across the file, so each test works in a Scope of its own.
let n = 0;
const fresh = () => karmi.scope(`s${++n}`);

const spec = (patch: Partial<AgentSpec> = {}): AgentSpec => ({ agentId: "concierge", name: "Concierge", instructions: [{ text: "Help." }], model: { id: "anthropic/claude-sonnet-5" }, ...patch });

describe("scope.config", () => {
  it("starts every Scope at revision 0 with an empty document", async () => {
    expect(await fresh().config.get()).toEqual({ revision: 0, document: {} });
  });

  it("stores each set as the next revision", async () => {
    const scope = fresh();
    expect(await scope.config.set({ ceilings: { longRunning: { maxSteps: 50 } } })).toEqual({ revision: 1 });
    expect(await scope.config.set({ ceilings: { longRunning: { maxSteps: 40 } } }, { ifRevision: 1 })).toEqual({ revision: 2 });
    expect(await scope.config.get()).toEqual({ revision: 2, document: { ceilings: { longRunning: { maxSteps: 40 } } } });
  });

  it("refuses a set against a stale revision", async () => {
    const scope = fresh();
    await scope.config.set({});
    await expect(scope.config.set({}, { ifRevision: 0 })).rejects.toThrowError(new KarmiError("config.conflict", "Scope config is at revision 1, not 0."));
    expect((await scope.config.get()).revision).toBe(1);
  });

  it("rejects secret values and unknown adapters without writing a revision", async () => {
    const scope = fresh();
    await expect(scope.config.set({ providers: { default: { adapter: "anthropic", apiKey: "sk-ant" } } } as never)).rejects.toMatchObject({ code: "config.secret-value" });
    await expect(scope.config.set({ providers: { default: { adapter: "nope" } } })).rejects.toThrowError(new KarmiError("config.invalid", 'Scope config is invalid at "/providers/default/adapter": no Provider "nope" is registered in createKarmi({ providers }).'));
    expect((await scope.config.get()).revision).toBe(0);
  });
});

describe("scope.agents", () => {
  it("puts a Spec and reads it back normalised at version 1", async () => {
    const scope = fresh();
    expect(await scope.agents.put(spec({ tools: ["weather"] }))).toEqual({ agentId: "concierge", version: 1 });
    const record = await scope.agents.get("concierge");
    expect(record).toMatchObject({ agentId: "concierge", version: 1, catalogueChanged: false });
    expect(record.spec.tools).toEqual([{ name: "weather" }]);
  });

  it("keeps every version and serves an old one on request", async () => {
    const scope = fresh();
    await scope.agents.put(spec({ name: "One" }));
    expect(await scope.agents.put(spec({ name: "Two" }), { ifVersion: 1 })).toEqual({ agentId: "concierge", version: 2 });
    expect((await scope.agents.get("concierge")).spec.name).toBe("Two");
    expect((await scope.agents.get("concierge", { version: 1 })).spec.name).toBe("One");
    expect(await scope.agents.history("concierge")).toEqual([expect.objectContaining({ version: 1 }), expect.objectContaining({ version: 2 })]);
  });

  it("refuses a put against a stale version, with 0 meaning create-only", async () => {
    const scope = fresh();
    await expect(scope.agents.put(spec(), { ifVersion: 1 })).rejects.toThrowError(new KarmiError("agent.conflict", 'Agent "concierge" is at version 0, not 1.'));
    await scope.agents.put(spec(), { ifVersion: 0 });
    await expect(scope.agents.put(spec(), { ifVersion: 0 })).rejects.toMatchObject({ code: "agent.conflict" });
  });

  it("throws SpecInvalidError carrying the full result, and validate() is the dry run", async () => {
    const scope = fresh();
    const bad = spec({ tools: ["nope"] });
    const error = await scope.agents.put(bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpecInvalidError);
    expect((error as SpecInvalidError).result.issues).toEqual([expect.objectContaining({ code: "ref.tool.unknown", path: "/tools/0/name" })]);
    expect(await scope.agents.validate(bad)).toEqual((error as SpecInvalidError).result);
    await expect(scope.agents.get("concierge")).rejects.toMatchObject({ code: "agent.notFound" });
  });

  it("validates against the Scope's config merged under the Deployment defaults", async () => {
    const scope = fresh();
    await scope.config.set({ ceilings: { longRunning: { maxSteps: 10 } }, providers: { default: { adapter: "fake", models: ["anthropic/*"] } } });
    await expect(scope.agents.put(spec({ capabilities: { longRunning: { maxSteps: 100 } } }))).rejects.toMatchObject({ code: "agent.spec.invalid" });
    await expect(scope.agents.put(spec({ model: { id: "openai/gpt-5" } }))).rejects.toMatchObject({ result: { issues: [expect.objectContaining({ code: "provider.model.unsupported" })] } });
    await scope.config.set({ providers: { default: { adapter: "fake", models: ["*"] } } });
    await expect(scope.agents.put(spec({ model: { id: "openai/gpt-5" } }))).resolves.toEqual({ agentId: "concierge", version: 1 });
  });

  it("validates the Memory profile as a union across the Scope's Agents", async () => {
    const scope = fresh();
    await scope.agents.put(spec({ agentId: "a", memory: { profile: { properties: { tier: { type: "number" } } } } }));
    await expect(scope.agents.put(spec({ agentId: "b", memory: { profile: { properties: { tier: { type: "string" } } } } }))).rejects.toMatchObject({
      result: { issues: [expect.objectContaining({ code: "memory.profile.conflict", context: { agentId: "a", type: "number" } })] },
    });
  });

  it("lists current Agents and tombstones on delete", async () => {
    const scope = fresh();
    await scope.agents.put(spec({ agentId: "a", name: "A" }));
    await scope.agents.put(spec({ agentId: "b", name: "B", description: "Second" }));
    expect(await scope.agents.list()).toEqual([
      { agentId: "a", version: 1, name: "A", updatedAt: expect.any(Number) },
      { agentId: "b", version: 1, name: "B", description: "Second", updatedAt: expect.any(Number) },
    ]);
    await scope.agents.delete("a");
    expect((await scope.agents.list()).map((a) => a.agentId)).toEqual(["b"]);
    await expect(scope.agents.get("a")).rejects.toThrowError(new KarmiError("agent.deleted", 'Agent "a" has been deleted.'));
    expect(await scope.agents.history("a")).toHaveLength(1);
    await expect(scope.agents.delete("zzz")).rejects.toMatchObject({ code: "agent.notFound" });
  });

  it("revives a deleted Agent on the next put, continuing its version history", async () => {
    const scope = fresh();
    await scope.agents.put(spec());
    await scope.agents.delete("concierge");
    expect(await scope.agents.put(spec())).toEqual({ agentId: "concierge", version: 2 });
    expect((await scope.agents.get("concierge")).version).toBe(2);
  });

  it("keeps the last 20 versions", async () => {
    const scope = fresh();
    for (let i = 1; i <= 22; i++) await scope.agents.put(spec({ name: `v${i}` }));
    const history = await scope.agents.history("concierge");
    expect(history.map((h) => h.version)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    await expect(scope.agents.get("concierge", { version: 2 })).rejects.toMatchObject({ code: "agent.notFound" });
  });

  it("isolates Scopes from each other", async () => {
    const a = fresh();
    const b = fresh();
    await a.agents.put(spec());
    await expect(b.agents.get("concierge")).rejects.toMatchObject({ code: "agent.notFound" });
  });
});

describe("scope lifecycle", () => {
  it("is active on first use and can be suspended and resumed", async () => {
    const scope = fresh();
    expect(await scope.status()).toEqual({ state: "active", configRevision: 0 });
    await scope.suspend();
    expect((await scope.status()).state).toBe("suspended");
    await scope.config.set({});
    await scope.resume();
    expect(await scope.status()).toEqual({ state: "active", configRevision: 1 });
  });

  it("destroys atomically and rejects every entry afterwards", async () => {
    const scope = fresh();
    await scope.agents.put(spec());
    const { operationId } = await scope.destroy();
    expect(operationId).toEqual(expect.any(String));
    expect((await scope.status()).state).toBe("destroying");
    expect(await scope.destroyStatus(operationId)).toEqual({ operationId, state: "destroying" });
    const destroyed = new KarmiError("scope.destroyed", `Scope "${scope.id}" has been destroyed.`);
    await expect(scope.config.get()).rejects.toThrowError(destroyed);
    await expect(scope.agents.get("concierge")).rejects.toThrowError(destroyed);
    await expect(scope.agents.put(spec())).rejects.toThrowError(destroyed);
    await expect(scope.suspend()).rejects.toThrowError(destroyed);
    await expect(scope.destroy()).resolves.toEqual({ operationId });
    await expect(scope.destroyStatus("nope")).rejects.toMatchObject({ code: "destroy.notFound" });
  });
});
