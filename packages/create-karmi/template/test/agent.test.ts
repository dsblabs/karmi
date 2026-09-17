import { lastMessage, reply } from "@karmi/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { provider, scope } from "./worker";

const say = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });

let n = 0;
const freshThread = () => scope.thread({ agent: "concierge", threadId: `t${++n}` });

describe("the concierge", () => {
  beforeEach(() => provider.script(["Good morning."]));

  it("answers a message", async () => {
    const events = await freshThread().send(say("Hello."));
    expect(lastMessage(events)).toBe("Good morning.");
    expect(events).toHaveSequence(["turn.started", "turn.completed"]);
  });

  it("calls the weather Tool and sees its result", async () => {
    provider.script([[reply.toolCall("weather", { city: "Paris" })], "It is sunny in Paris."]);
    const events = await freshThread().send(say("What is the weather in Paris?"));
    expect(events).toContainEvent({ type: "tool.result", name: "weather" });
    expect(lastMessage(events)).toBe("It is sunny in Paris.");
  });

  it("sends the Tool the model may use, with its schema", async () => {
    await freshThread().send(say("Hello."));
    const [request] = provider.requests;
    expect(request?.tools?.map((tool) => tool.name)).toContain("weather");
  });
});
