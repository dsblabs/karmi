import { describe, expect, it } from "vitest";
import { evaluatePolicy, explicitEffect } from "../src/policy";
import type { PolicyRule } from "../src/index";
import type { ToolAnnotations } from "../src/index";

const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const rw: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

describe("evaluatePolicy", () => {
  it("defaults to ask when no rule matches", () => {
    expect(evaluatePolicy([], { name: "weather", annotations: ro })).toBe("ask");
  });

  it("takes the first matching rule, matching by tool glob or by every listed annotation", () => {
    const rules: PolicyRule[] = [
      { match: { tool: "book*" }, effect: "deny" },
      { match: { annotations: { readOnlyHint: true } }, effect: "allow" },
      { match: { tool: ["*"] }, effect: "ask" },
    ];
    expect(evaluatePolicy(rules, { name: "booking", annotations: ro })).toBe("deny");
    expect(evaluatePolicy(rules, { name: "weather", annotations: ro })).toBe("allow");
    expect(evaluatePolicy(rules, { name: "send_mail", annotations: rw })).toBe("ask");
  });

  it("requires both tool and annotations of one rule to match", () => {
    const rules: PolicyRule[] = [{ match: { tool: "weather", annotations: { readOnlyHint: false } }, effect: "deny" }];
    expect(evaluatePolicy(rules, { name: "weather", annotations: ro })).toBe("ask");
  });

  it("turns only an ask into an allow for a remembered Tool name", () => {
    const remembered = new Set(["weather"]);
    const ask: PolicyRule[] = [{ match: { tool: "*" }, effect: "ask" }];
    expect(evaluatePolicy(ask, { name: "weather", annotations: ro }, remembered)).toBe("allow");
    expect(evaluatePolicy([], { name: "weather", annotations: ro }, remembered)).toBe("allow");
    expect(evaluatePolicy(ask, { name: "booking", annotations: ro }, remembered)).toBe("ask");
  });

  it("lets a deny rule win over a remembered Tool name", () => {
    const rules: PolicyRule[] = [
      { match: { tool: "weather" }, effect: "deny" },
      { match: { tool: "*" }, effect: "ask" },
    ];
    expect(evaluatePolicy(rules, { name: "weather", annotations: ro }, new Set(["weather"]))).toBe("deny");
  });
});

describe("explicitEffect", () => {
  const remembered = new Set(["weather"]);

  it("gives the effect of the first matching rule, and nothing when no rule matches", () => {
    const rules: PolicyRule[] = [{ match: { tool: "weather" }, effect: "ask" }];
    expect(explicitEffect(rules, { name: "weather", annotations: ro })).toBe("ask");
    expect(explicitEffect(rules, { name: "booking", annotations: ro })).toBeUndefined();
  });

  it("lets a deny rule win over a remembered Tool name", () => {
    const rules: PolicyRule[] = [{ match: { tool: "weather" }, effect: "deny" }];
    expect(explicitEffect(rules, { name: "weather", annotations: ro }, remembered)).toBe("deny");
  });

  it("gives allow for a remembered Tool name over an ask and over no match", () => {
    const rules: PolicyRule[] = [{ match: { tool: "weather" }, effect: "ask" }];
    expect(explicitEffect(rules, { name: "weather", annotations: ro }, remembered)).toBe("allow");
    expect(explicitEffect([], { name: "weather", annotations: ro }, remembered)).toBe("allow");
  });
});
