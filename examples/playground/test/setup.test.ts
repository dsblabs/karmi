import { describe, expect, it } from "vitest";
import { buildDevVars, chooseOption, generate, parseDevVars } from "../setup/cli.ts";
import { rotateDevVars } from "../setup/rotate-key.ts";
import { decodeKeyring, keyringView } from "../src/keyring";
import { PROVIDER_OPTIONS, readSetup } from "../src/provider-options";

describe("setup", () => {
  it("offers the five Providers by number or id", () => {
    expect(PROVIDER_OPTIONS.map((option) => option.id)).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "custom",
    ]);
    expect(chooseOption("2")?.id).toBe("anthropic");
    expect(chooseOption("OpenRouter")?.id).toBe("openrouter");
    expect(chooseOption("9")).toBeUndefined();
  });

  it("writes a file that the Worker reads back as the same selection", () => {
    const option = chooseOption("custom");
    if (!option) throw new Error("The custom option is missing.");
    const answers = { option, model: "llama-4", apiKey: 'k"ey\\#1', baseUrl: "https://host.example/v1" };
    const vars = parseDevVars(buildDevVars(answers, {}, generate()));
    expect(readSetup(vars)).toEqual({ option, model: "llama-4", baseUrl: "https://host.example/v1" });
    expect(vars.PROVIDER_API_KEY).toBe('k"ey\\#1');
    expect(vars.PLAYGROUND_TOKEN).toMatch(/^[\w-]{32}$/);
    expect(JSON.parse(vars.KARMI_KEYRING ?? "")).toMatchObject({ active: "v1" });
  });

  it("refuses a value that the file cannot hold", () => {
    const option = chooseOption("openai");
    if (!option) throw new Error("The openai option is missing.");
    expect(() => buildDevVars({ option, model: "m", apiKey: "it's" }, {}, generate())).toThrow(/single quote/);
  });

  it("keeps the access token and the key ring of an earlier run", () => {
    const option = chooseOption("openai");
    if (!option) throw new Error("The openai option is missing.");
    const first = parseDevVars(buildDevVars({ option, model: "a", apiKey: "k1" }, {}, generate()));
    const second = parseDevVars(buildDevVars({ option, model: "b", apiKey: "k2" }, first, generate()));
    expect(second.PLAYGROUND_TOKEN).toBe(first.PLAYGROUND_TOKEN);
    expect(second.KARMI_KEYRING).toBe(first.KARMI_KEYRING);
    expect(second.PROVIDER_API_KEY).toBe("k2");
  });

  it("reports no selection when a custom endpoint has no base URL", () => {
    expect(readSetup({ PLAYGROUND_PROVIDER: "custom", PLAYGROUND_MODEL: "m" })).toBeUndefined();
    expect(readSetup({})).toBeUndefined();
  });

  it("rotates the key ring and keeps each other line of the file", () => {
    const option = chooseOption("openai");
    if (!option) throw new Error("The openai option is missing.");
    const text = buildDevVars({ option, model: "m", apiKey: "k1" }, {}, generate());
    const before = parseDevVars(text);
    const rotated = rotateDevVars(text, "new$&key", false);
    const after = parseDevVars(rotated.text);
    expect(rotated.keyring.active).toBe("v2");
    expect(decodeKeyring(after.KARMI_KEYRING)).toEqual({
      active: "v2",
      keys: { v1: decodeKeyring(before.KARMI_KEYRING)?.keys.v1, v2: "new$&key" },
    });
    expect({ ...after, KARMI_KEYRING: "" }).toEqual({ ...before, KARMI_KEYRING: "" });

    const retired = parseDevVars(rotateDevVars(rotated.text, "unused", true).text);
    expect(keyringView(retired.KARMI_KEYRING)).toEqual({ active: "v2", keys: ["v2"] });
  });

  it("refuses to rotate a file without a key ring", () => {
    expect(() => rotateDevVars("PLAYGROUND_TOKEN='t'\n", "key", false)).toThrow(/pnpm setup/);
  });
});
