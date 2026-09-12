import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig, ThreadEvent } from "../src/index";
import { reply, type Reply } from "../src/testing/index";
import { sensitive } from "../src/secrets";
import { karmi, provider, revocations, secrets } from "./worker";

// Each test works in a Scope of its own, with the `byok` Agent on the Scope's `own` profile. The
// Deployment profile `shared` (credential `deployment:shared`, value "deployment-key") is the fallback target.

let n = 0;
const message = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });

/** `key: null` leaves the Scope without a credential. */
async function setup(profile: Partial<ProviderConfig> = {}, key: string | null = "tenant-key") {
  const id = `turn${++n}`;
  const scope = karmi.scope(id);
  await scope.config.set({
    providers: { own: { adapter: "fake", models: ["*"], credential: "scope:anthropic", ...profile } },
  });
  if (key !== null) await secrets.put({ scope: id, ref: "scope:anthropic" }, sensitive(key));
  const thread = scope.thread({ agent: "byok", user: "u", threadId: "t" });
  return {
    id,
    scope,
    async send(text: string): Promise<ThreadEvent[]> {
      const { turn, seq } = await thread.send(message(text));
      const events: ThreadEvent[] = [];
      for await (const event of thread.subscribe({ after: seq })) {
        if (event.turn !== turn) continue;
        events.push(event);
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.paused") break;
      }
      return events;
    },
  };
}

/** What the fake adapter was handed on each call; the only place the value may show up. */
const seen: (string | undefined)[] = [];
const recording = (replies: Reply[]) =>
  provider.script((ctx) => {
    seen.push(ctx.options.credentials?.provider?.expose());
    const next = replies[ctx.index];
    if (next === undefined) throw new Error(`no reply for call ${ctx.index}`);
    return next;
  });
const started = (events: ThreadEvent[]) =>
  events.flatMap((event) => (event.type === "step.started" && event.kind === "model" ? [event] : []));

afterEach(() => {
  seen.length = 0;
  revocations.length = 0;
  provider.script(["OK"]);
});

describe("credentials in a Turn", () => {
  it("resolves the Scope credential before each model Step, hands it only to the adapter and logs its version", async () => {
    const { send } = await setup();
    recording([[reply.toolCall("weather", { city: "Oslo" })], [reply.text("Sunny")]]);
    const events = await send("weather?");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(seen).toEqual(["tenant-key", "tenant-key"]);
    expect(
      started(events).map((e) => ({ n: e.n, profile: e.profile, credential: e.credential, fallback: e.fallback })),
    ).toEqual([
      {
        n: 1,
        profile: "own",
        credential: { ref: "scope:anthropic", source: "scope", version: 1 },
        fallback: undefined,
      },
      {
        n: 3,
        profile: "own",
        credential: { ref: "scope:anthropic", source: "scope", version: 1 },
        fallback: undefined,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("tenant-key");
    expect(JSON.stringify(provider.requests)).not.toContain("tenant-key");
  });

  it("picks up a new version and a revocation at the next Step, even inside one long Turn", async () => {
    const { id, send } = await setup();
    recording(["one"]);
    await send("first");
    await secrets.put({ scope: id, ref: "scope:anthropic" }, sensitive("tenant-key-2"));
    recording([[reply.toolCall("revoke_credential", { scope: id, name: "anthropic" })], ["never"]]);
    const events = await send("second");
    expect(seen).toEqual(["tenant-key", "tenant-key-2"]);
    expect(started(events)[0]?.credential).toMatchObject({ version: 2 });
    expect(revocations).toEqual(["anthropic"]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      reason: "credential.missing",
      message: 'Credential "scope:anthropic" of Agent "byok" is missing or revoked.',
    });
  });

  it("fails the Turn when the credential is missing and the profile opted into no fallback", async () => {
    const { send } = await setup({}, null);
    const events = await send("hi");
    expect(seen).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", reason: "credential.missing" });
  });

  it("falls back to the Deployment profile on a missing credential by default", async () => {
    const { send } = await setup({ fallback: { profile: "shared" } }, null);
    recording(["from shared"]);
    const events = await send("hi");
    expect(seen).toEqual(["deployment-key"]);
    expect(started(events)[0]).toMatchObject({
      profile: "shared",
      provider: "fake",
      credential: { ref: "deployment:shared", source: "deployment", version: 1 },
      fallback: { from: "own", reason: "missing" },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("does not fall back for a reason the profile left out", async () => {
    const { send } = await setup({ fallback: { profile: "shared", on: ["auth"] } }, null);
    const events = await send("hi");
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", reason: "credential.missing" });
  });

  it("retries the same model on the fallback after a listed Provider error and stays there for the Turn", async () => {
    const { send } = await setup({ fallback: { profile: "shared", on: ["auth", "rate_limit"] } });
    recording([
      [reply.error({ code: "auth", message: "invalid x-api-key" })],
      [reply.toolCall("weather", { city: "Oslo" })],
      [reply.text("Sunny")],
    ]);
    const events = await send("weather?");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(seen).toEqual(["tenant-key", "deployment-key", "deployment-key"]);
    expect(
      started(events).map(({ n, attempt, model, profile, fallback }) => ({ n, attempt, model, profile, fallback })),
    ).toEqual([
      { n: 1, attempt: 1, model: "fake/m", profile: "own", fallback: undefined },
      { n: 1, attempt: 2, model: "fake/m", profile: "shared", fallback: { from: "own", reason: "auth" } },
      { n: 3, attempt: 1, model: "fake/m", profile: "shared", fallback: { from: "own", reason: "auth" } },
    ]);
    // The next Turn starts on the Scope's own profile again.
    recording(["back"]);
    expect(started(await send("again"))[0]).toMatchObject({ profile: "own", credential: { version: 1 } });
    expect(seen.at(-1)).toBe("tenant-key");
  });

  it("rotates models, not credentials, for an error the profile did not list", async () => {
    const { send } = await setup({ fallback: { profile: "shared", on: ["auth"] } });
    recording([[reply.error({ code: "quota", message: "over quota" })], ["second model"]]);
    const events = await send("hi");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(seen).toEqual(["tenant-key", "tenant-key"]);
    expect(started(events).map(({ attempt, model, profile }) => ({ attempt, model, profile }))).toEqual([
      { attempt: 1, model: "fake/m", profile: "own" },
      { attempt: 2, model: "fake/n", profile: "own" },
    ]);
  });
});
