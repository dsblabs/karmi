import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/policy.js";
import type { PolicyRule } from "../src/index.js";
import type { ToolAnnotations } from "../src/index.js";

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

  it("consults Thread-level remembered allows before any rule", () => {
    const rules: PolicyRule[] = [{ match: { tool: "*" }, effect: "deny" }];
    expect(evaluatePolicy(rules, { name: "weather", annotations: ro }, new Set(["weather"]))).toBe("allow");
  });
});
