import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertCompatibilityBaseline, createKarmi, defineTool, KarmiError, resolveBindings } from "../src/index";

describe("createKarmi", () => {
  it("boots the Worker in workerd and serves describe()", async () => {
    const response = await exports.default.fetch(new Request("http://karmi/describe"));
    expect(response.status).toBe(200);
    const description = await response.json();
    expect(description).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "weather", annotations: expect.objectContaining({ readOnlyHint: true }) }),
      ]),
      agents: expect.arrayContaining([{ agentId: "concierge", name: "Concierge" }]),
    });
  });

  it("rejects duplicate names at boot", () => {
    const t = defineTool({ name: "t", description: "d", input: z.object({}), execute: () => "" });
    expect(() => createKarmi({ catalogue: { tools: [t, t] } })).toThrowError(/Duplicate tool name "t"/);
  });

  it("exposes the Durable Object classes as named exports", () => {
    expect(exports.ThreadDO).toBeTypeOf("function");
    expect(exports.ScopeConfigDO).toBeTypeOf("function");
    expect(exports.MemoryDO).toBeTypeOf("function");
  });

  it("validates the ScopeId on scope()", () => {
    const karmi = createKarmi({ catalogue: {} });
    expect(karmi.scope("tenant_1").id).toBe("tenant_1");
    expect(() => karmi.scope("bad/id")).toThrowError(
      new KarmiError("scope.id.invalid", 'ScopeId "bad/id" must match [A-Za-z0-9_-]{1,64}.'),
    );
  });
});

describe("bindings", () => {
  it("resolves by the fixed KARMI_* names", () => {
    const bindings = resolveBindings(env);
    expect(bindings.KARMI_THREADS).toBe(env.KARMI_THREADS);
    expect(bindings.KARMI_SCOPES).toBe(env.KARMI_SCOPES);
    expect(bindings.KARMI_MEDIA).toBe(env.KARMI_MEDIA);
  });

  it("lets bindings(env) rename them", () => {
    const renamed = { THREADS: env.KARMI_THREADS, SCOPES: env.KARMI_SCOPES, MEMORY: env.KARMI_MEMORY };
    const bindings = resolveBindings(renamed, (e) => ({
      KARMI_THREADS: e.THREADS,
      KARMI_SCOPES: e.SCOPES,
      KARMI_MEMORY: e.MEMORY,
    }));
    expect(bindings.KARMI_THREADS).toBe(env.KARMI_THREADS);
    expect(bindings.KARMI_MEDIA).toBeUndefined();
  });

  it("fails clearly when a required binding is missing", () => {
    expect(() => resolveBindings({ KARMI_THREADS: env.KARMI_THREADS, KARMI_MEMORY: env.KARMI_MEMORY })).toThrowError(
      new KarmiError(
        "bindings.missing",
        "Missing Durable Object binding KARMI_SCOPES; see @karmi/core/wrangler.baseline.jsonc.",
      ),
    );
  });
});

describe("compatibility baseline", () => {
  it("passes on the test Worker", () => {
    expect(() => assertCompatibilityBaseline()).not.toThrow();
  });

  it("fails at startup below the date floor", () => {
    expect(() => assertCompatibilityBaseline({})).toThrowError(
      new KarmiError(
        "compatibility.date",
        "karmi requires compatibility_date >= 2026-08-04 (ADR-0002); set it in wrangler.jsonc.",
      ),
    );
  });
});
