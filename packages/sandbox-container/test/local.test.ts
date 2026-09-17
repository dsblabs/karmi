import { afterEach, expect, it } from "vitest";
import { LocalProcessSandbox } from "../src/index";
import type { ContainerHost, ContainerRun, SandboxRequest, SandboxResult } from "@karmi/core/sandbox";

const sandboxes: LocalProcessSandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cancel()));
});

function setup(wallMs = 5000, maxArtifacts = 20) {
  let state: ContainerRun | undefined;
  const artifacts = new Map<string, Uint8Array>();
  const progress: string[] = [];
  const host: ContainerHost = {
    now: Date.now,
    read: () => state,
    save: (run) => {
      state = run;
    },
    clear: () => {
      state = undefined;
    },
    progress: (_, text) => {
      progress.push(text);
    },
    maxBytes: 1024,
    load: async () => new TextEncoder().encode("hello"),
    store: async (name, bytes) => {
      artifacts.set(name, bytes);
      return { id: name, key: `scope/media/thread/${name}`, bytes: bytes.length, mimeType: "text/plain" };
    },
  };
  const sandbox = new LocalProcessSandbox(host, { wallMs, jobMaxWallMs: 3000, idleMs: 1000, maxArtifacts });
  sandboxes.push(sandbox);
  return { sandbox, host, artifacts, progress };
}
function request(code: string, language: "shell" | "python" = "shell"): SandboxRequest {
  return {
    code,
    container: { code, language },
    limits: { wallMs: 5000, cpuMs: 1000, maxToolCalls: 0 },
    signal: new AbortController().signal,
    tools: [],
    call: async () => {
      throw new Error("No Tool bridge.");
    },
    result: async () => {
      throw new Error("No Tool bridge.");
    },
  };
}

it("runs shell with named input, exports output, and omits host secrets", async () => {
  const { sandbox, artifacts } = setup();
  process.env.KARMI_LOCAL_TEST_SECRET = "do-not-inherit";
  const input = request('cat /in/source.txt > /out/copy.txt; printf "value=%s" "$KARMI_LOCAL_TEST_SECRET"');
  input.container = {
    code: input.code,
    language: "shell",
    files: { "source.txt": { id: "source", key: "scope/media/thread/source", mimeType: "text/plain", bytes: 5 } },
  };
  const result = await sandbox.run(input);
  delete process.env.KARMI_LOCAL_TEST_SECRET;
  expect(result).toMatchObject({ value: { stdout: "value=" }, artifacts: [{ id: "copy.txt" }] });
  expect(new TextDecoder().decode(artifacts.get("copy.txt"))).toBe("hello");
  expect(sandbox.security).toContain("egress not enforced");
});

it("runs Python and preserves the Workspace between calls", async () => {
  const { sandbox } = setup();
  await sandbox.run(request("printf cache > cache.txt"));
  const result = await sandbox.run(request('print(open("cache.txt").read())', "python"));
  expect(result).toMatchObject({ value: { stdout: "cache\n" } });
});

it("promotes one process in place and polls its eventual completion", async () => {
  const { sandbox, host } = setup(1);
  const result = await sandbox.run(request("sleep 0.15; echo complete"));
  expect(result).toHaveProperty("pending", host.read()?.processId);
  let completed: SandboxResult | undefined;
  await expect
    .poll(async () => {
      completed = await sandbox.poll();
      return completed;
    })
    .toBeDefined();
  expect(completed).toMatchObject({ value: { stdout: "complete\n" } });
});

it("kills a promoted process on cancellation and removes the Workspace", async () => {
  const { sandbox, host } = setup(1);
  await sandbox.run(request("sleep 60"));
  expect(host.read()).toBeDefined();
  await sandbox.cancel();
  expect(host.read()).toBeUndefined();
  expect(await sandbox.run(request("test ! -e cache.txt"))).toBeDefined();
});

it("refuses excess artifacts and oversized files", async () => {
  const { sandbox } = setup(5000, 1);
  expect(await sandbox.run(request("touch /out/a /out/b"))).toMatchObject({
    error: { message: "maxArtifacts exceeded." },
  });
  await sandbox.cancel();
  expect(await sandbox.run(request("head -c 1025 /dev/zero > /out/big"))).toMatchObject({
    error: { message: "Artifact exceeds Scope media.maxBytes." },
  });
});

it("reports nonzero exit and clears a finished process", async () => {
  const { sandbox, host } = setup();
  expect(await sandbox.run(request("echo failed >&2; exit 7"))).toMatchObject({ error: { message: "failed\n" } });
  expect(host.read()).toBeUndefined();
});

it("executes a new Script after artifact export fails", async () => {
  const { sandbox } = setup(5000, 1);
  expect(await sandbox.run(request("touch /out/a /out/b"))).toHaveProperty("error");
  expect(await sandbox.run(request("echo next"))).toMatchObject({ value: { stdout: "next\n" } });
});

it("retains completed Job results until acknowledged and drains UTF-8 progress", async () => {
  const { sandbox, host, progress } = setup(1);
  await sandbox.run(request('import time; time.sleep(0.15); print("🌍" * 4000)', "python"));
  let result: SandboxResult | undefined;
  await expect
    .poll(async () => {
      result = await sandbox.poll();
      return result;
    })
    .toBeDefined();
  expect(progress.join("")).toBe("🌍".repeat(4000) + "\n");
  expect(progress.every((chunk) => new TextEncoder().encode(chunk).length <= 4096)).toBe(true);
  expect(host.read()?.completion).toEqual(result);
  expect(await sandbox.poll()).toEqual(result);
  sandbox.acknowledge();
  expect(host.read()).toBeUndefined();
});
