import { describe, expect, it } from "vitest";
import { parseScopeConfig, type Provider, type ProviderEvent, type ProviderRequest } from "../src/index.js";
import { fakeProvider, recordingProvider, reply } from "../src/testing/index.js";

const request = (text: string, model = "claude-sonnet-5"): ProviderRequest => ({ model, config: { adapter: "fake" }, messages: [{ role: "user", content: [{ type: "text", text }] }] });
const call = { fetch, signal: new AbortController().signal };

async function collect(provider: Provider, req: ProviderRequest, options = call): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(req, options)) events.push(event);
  return events;
}

describe("fakeProvider", () => {
  it("answers a string with one streamed text message", async () => {
    const provider = fakeProvider(() => "Hello");
    expect(await collect(provider, request("hi"))).toEqual([
      { type: "message.start", model: "claude-sonnet-5" },
      { type: "delta", index: 0, kind: "text", text: "Hello" },
      { type: "part", index: 0, block: { type: "text", text: "Hello" } },
      { type: "message.end", stopReason: "end_turn", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  it("composes reasoning, text chunks, tool calls, usage and raw events in order", async () => {
    const provider = fakeProvider(() => [reply.reasoning("hmm"), reply.text("Sun", "ny"), reply.toolCall("weather", { city: "Oslo" }, "c1"), reply.usage({ input: 12, output: 3, cacheRead: 5 }), reply.raw({ vendor: true })]);
    const events = await collect(provider, request("weather?"));
    expect(events.map((e) => e.type)).toEqual(["message.start", "delta", "part", "delta", "delta", "part", "delta", "part", "raw", "message.end"]);
    expect(events[2]).toEqual({ type: "part", index: 0, block: { type: "thinking", text: "hmm" } });
    expect(events[5]).toEqual({ type: "part", index: 1, block: { type: "text", text: "Sunny" } });
    expect(events[7]).toEqual({ type: "part", index: 2, block: { type: "tool_call", id: "c1", name: "weather", input: { city: "Oslo" } } });
    expect(events.at(-1)).toEqual({ type: "message.end", stopReason: "tool_use", usage: { input: 12, output: 3, cacheRead: 5, cacheWrite: 0 } });
  });

  it("ends with an error event instead of throwing, and lets a test pick the stop reason", async () => {
    const provider = fakeProvider([reply.error({ code: "rate_limit", retryable: true }), [reply.text("cut"), reply.stop("max_tokens")]]);
    expect((await collect(provider, request("a"))).at(-1)).toEqual({ type: "error", error: { code: "rate_limit", message: "rate_limit", retryable: true } });
    expect((await collect(provider, request("b"))).at(-1)).toMatchObject({ type: "message.end", stopReason: "max_tokens" });
  });

  it("consumes a list one reply per call and fails loudly when it runs out", async () => {
    const provider = fakeProvider(["one", "two"]);
    await collect(provider, request("1"));
    await collect(provider, request("2"));
    await expect(collect(provider, request("3"))).rejects.toMatchObject({ code: "test.script-exhausted" });
  });

  it("records every request, deep-copied, and hands the script the call index", async () => {
    const provider = fakeProvider(({ request, index }) => `#${index}: ${(request.messages[0] as { content: { text: string }[] }).content[0]!.text}`);
    const req = request("first");
    await collect(provider, req);
    req.messages.push({ role: "user", content: [{ type: "text", text: "mutated" }] });
    await collect(provider, request("second"));
    expect(provider.requests.map((r) => r.messages.length)).toEqual([1, 1]);
    expect(provider.requests[1]?.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "second" }] });
  });

  it("streams raw ProviderEvents verbatim", async () => {
    const events: ProviderEvent[] = [{ type: "message.start", model: "m" }, { type: "message.end", stopReason: "refusal", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }];
    expect(await collect(fakeProvider([events]), request("x"))).toEqual(events);
  });

  it("stops with an aborted error once the signal fires", async () => {
    const controller = new AbortController();
    const provider = fakeProvider(() => [reply.text("a"), reply.text("b")]);
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream(request("x"), { fetch, signal: controller.signal })) {
      events.push(event);
      if (event.type === "part") controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: "error", error: { code: "aborted", message: "aborted", retryable: false } });
    expect(events.filter((e) => e.type === "part")).toHaveLength(1);
  });

  it("is fully capable by default, overridable, and counts tokens when told how", async () => {
    expect(fakeProvider(() => "x").capabilities("any")).toEqual({ image: true, audio: true, video: true, pdf: true });
    const provider = fakeProvider(() => "x", { capabilities: { pdf: false, maxMediaBytes: 1024 }, countTokens: (req) => req.messages.length * 10 });
    expect(provider.capabilities("any")).toMatchObject({ pdf: false, maxMediaBytes: 1024, image: true });
    await expect(provider.countTokens!(request("x"), call)).resolves.toEqual({ tokens: 10 });
    expect(fakeProvider(() => "x").countTokens).toBeUndefined();
  });

  it("registers as an ordinary Provider profile", () => {
    const config = parseScopeConfig({ providers: { default: { adapter: "fake", models: ["*"] } } }, { fake: fakeProvider(() => "x") });
    expect(config.providers?.default).toEqual({ adapter: "fake", models: ["*"] });
  });
});

describe("recordingProvider and fakeProvider.fromRecording", () => {
  const real = fakeProvider(({ request }) => [reply.text(`echo ${(request.messages[0] as { content: { text: string }[] }).content[0]!.text}`), reply.usage({ input: 7, output: 2 })], { capabilities: { pdf: "unknown" }, countTokens: () => 42 });

  it("captures request and events per call and serialises to JSONL", async () => {
    const recorder = recordingProvider(real);
    await collect(recorder, request("one"));
    await collect(recorder, request("two"));
    expect(recorder.entries).toHaveLength(2);
    expect(recorder.entries[1]?.events.at(-1)).toMatchObject({ type: "message.end", usage: { input: 7, output: 2 } });
    const lines = recorder.toJSONL().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(recorder.entries[0]);
    expect(recorder.capabilities("m")).toEqual(real.capabilities("m"));
    await expect(recorder.countTokens!(request("x"), call)).resolves.toEqual({ tokens: 42 });
  });

  it("replays by index", async () => {
    const recorder = recordingProvider(real);
    await collect(recorder, request("one"));
    await collect(recorder, request("two"));
    const replayed = fakeProvider.fromRecording(recorder.toJSONL());
    expect((await collect(replayed, request("anything"))).at(-2)).toEqual({ type: "part", index: 0, block: { type: "text", text: "echo one" } });
    expect((await collect(replayed, request("anything"))).at(-2)).toEqual({ type: "part", index: 0, block: { type: "text", text: "echo two" } });
    await expect(collect(replayed, request("anything"))).rejects.toMatchObject({ code: "test.recording-exhausted" });
  });

  it("replays by key, each entry once", async () => {
    const key = (req: ProviderRequest) => (req.messages.at(-1) as { content: { text: string }[] }).content[0]!.text;
    const recorder = recordingProvider(real, { key });
    await collect(recorder, request("one"));
    await collect(recorder, request("two"));
    expect(recorder.entries.map((e) => e.key)).toEqual(["one", "two"]);
    const replayed = fakeProvider.fromRecording(recorder.entries, { key });
    expect((await collect(replayed, request("two"))).at(-2)).toEqual({ type: "part", index: 0, block: { type: "text", text: "echo two" } });
    expect((await collect(replayed, request("one"))).at(-2)).toEqual({ type: "part", index: 0, block: { type: "text", text: "echo one" } });
    await expect(collect(replayed, request("two"))).rejects.toMatchObject({ code: "test.recording-miss" });
    expect(replayed.requests).toHaveLength(3);
  });
});
