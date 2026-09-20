import { describe, expect, it } from "vitest";
import {
  createManifest,
  decodeAccounts,
  deploy,
  parseDeploymentArguments,
  remove,
  selectAccount,
  type CommandRequest,
  type DeploymentManifest,
} from "../setup/deployment.ts";

const account = { id: "account-1", name: "Example account" };

function copy(manifest: DeploymentManifest): DeploymentManifest {
  return structuredClone(manifest);
}

describe("Cloudflare deployment", () => {
  it("selects an authenticated account by position, id or name", () => {
    const accounts = decodeAccounts({ accounts: [account, { id: "account-2", name: "Second" }] });
    expect(selectAccount(accounts, "2")?.id).toBe("account-2");
    expect(selectAccount(accounts, "account-1")).toEqual(account);
    expect(selectAccount(accounts, "Example account")).toEqual(account);
    expect(selectAccount(accounts, "missing")).toBeUndefined();
  });

  it("records resources supplied at the command boundary", () => {
    const arguments_ = parseDeploymentArguments([
      "test-deployment",
      "--bucket",
      "shared-media",
      "--queue",
      "shared-queue",
    ]);
    const manifest = createManifest(arguments_.name ?? "missing", account, arguments_.supplied);
    expect(manifest).toMatchObject({
      name: "test-deployment",
      bucket: { name: "shared-media", owned: false },
      queue: { name: "shared-queue", owned: false },
      deadLetterQueue: { owned: true },
    });
  });

  it("checkpoints creation and retries only unfinished resources", async () => {
    const manifest = createManifest("karmi-playground-test-a1b2", account);
    const saved: DeploymentManifest[] = [];
    const firstCalls: CommandRequest[] = [];
    await expect(
      deploy(
        manifest,
        { PROVIDER_API_KEY: "secret" },
        ".deployments/test/wrangler.jsonc",
        {
          run(request) {
            firstCalls.push(request);
            if (request.args.includes("info") || request.args[0] === "deployments") {
              return Promise.reject(new Error("not found"));
            }
            if (request.args[0] === "queues" && request.args.includes(manifest.queue.name)) {
              return Promise.reject(new Error("interrupted"));
            }
            return Promise.resolve("");
          },
        },
        {
          save(current) {
            saved.push(copy(current));
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("interrupted");
    expect(saved.at(-1)).toMatchObject({ bucket: { status: "created" }, deadLetterQueue: { status: "created" } });

    const retryCalls: CommandRequest[] = [];
    await deploy(
      manifest,
      { PROVIDER_API_KEY: "secret" },
      ".deployments/test/wrangler.jsonc",
      {
        run(request) {
          retryCalls.push(request);
          return Promise.resolve("");
        },
      },
      {
        save(current) {
          saved.push(copy(current));
          return Promise.resolve();
        },
      },
    );
    expect(retryCalls.map((request) => request.args)).toEqual([
      ["queues", "create", manifest.queue.name],
      ["secret", "bulk", "--config", ".deployments/test/wrangler.jsonc"],
      ["deploy", "--config", ".deployments/test/wrangler.jsonc"],
    ]);
    expect(retryCalls.every((request) => request.env?.CLOUDFLARE_ACCOUNT_ID === account.id)).toBe(true);
    expect(manifest.worker.status).toBe("created");
  });

  it("refuses to adopt a resource that existed before setup", async () => {
    const manifest = createManifest("karmi-playground-test-existing", account);
    await expect(
      deploy(
        manifest,
        { PROVIDER_API_KEY: "secret" },
        "config.json",
        {
          run() {
            return Promise.resolve("");
          },
        },
        {
          save() {
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("is not owned by this deployment");
    expect(manifest.bucket.status).toBe("pending");
  });

  it("does not remove resource names whose creation never started", async () => {
    const manifest = createManifest("karmi-playground-test-pending", account);
    const calls: CommandRequest[] = [];
    expect(
      await remove(
        manifest,
        {
          run(request) {
            calls.push(request);
            return Promise.resolve("");
          },
        },
        {
          save() {
            return Promise.resolve();
          },
        },
      ),
    ).toEqual({ complete: true, preserved: [] });
    expect(calls).toEqual([]);
  });

  it("removes owned resources and preserves supplied resources", async () => {
    const manifest = createManifest("karmi-playground-test-c3d4", account, { bucket: "shared-media" });
    manifest.worker.status = "created";
    manifest.queue.status = "created";
    manifest.deadLetterQueue.status = "created";
    const calls: CommandRequest[] = [];
    const result = await remove(
      manifest,
      {
        run(request) {
          calls.push(request);
          return Promise.resolve("");
        },
      },
      {
        save() {
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ complete: true, preserved: ["bucket shared-media"] });
    expect(calls.map((request) => request.args)).toEqual([
      ["queues", "consumer", "remove", manifest.queue.name, manifest.worker.name],
      ["delete", manifest.worker.name, "--force"],
      ["queues", "delete", manifest.queue.name],
      ["queues", "delete", manifest.deadLetterQueue.name],
    ]);
  });

  it("reports leftovers and a later removal retries only those resources", async () => {
    const manifest = createManifest("karmi-playground-test-e5f6", account);
    manifest.worker.status = "created";
    manifest.queue.status = "created";
    manifest.deadLetterQueue.status = "created";
    manifest.bucket.status = "created";
    const first = await remove(
      manifest,
      {
        run(request) {
          return request.args[1] === "delete" && request.args.includes(manifest.queue.name)
            ? Promise.reject(new Error("Queue is not empty"))
            : Promise.resolve("");
        },
      },
      {
        save() {
          return Promise.resolve();
        },
      },
    );
    expect(first).toEqual({
      complete: false,
      preserved: [],
      failures: [{ resource: `queue ${manifest.queue.name}`, message: "Queue is not empty" }],
    });
    const retried: CommandRequest[] = [];
    expect(
      await remove(
        manifest,
        {
          run(request) {
            retried.push(request);
            return Promise.resolve("");
          },
        },
        {
          save() {
            return Promise.resolve();
          },
        },
      ),
    ).toEqual({ complete: true, preserved: [] });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.args).toContain(manifest.queue.name);
  });

  it("keeps the Worker retryable when Queue consumer removal fails", async () => {
    const manifest = createManifest("karmi-playground-test-consumer", account, { queue: "shared-queue" });
    manifest.worker.status = "created";
    const calls: CommandRequest[] = [];
    const result = await remove(
      manifest,
      {
        run(request) {
          calls.push(request);
          return Promise.reject(new Error("Consumer removal failed"));
        },
      },
      { save: () => Promise.resolve() },
    );
    expect(result).toMatchObject({
      complete: false,
      failures: [{ resource: `queue consumer ${manifest.worker.name}` }],
    });
    expect(calls).toHaveLength(1);
    expect(manifest.worker.status).toBe("created");
  });
});
