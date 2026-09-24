import { describe, expect, it } from "vitest";
import {
  addContainerScripts,
  addVectorRetrieval,
  createManifest,
  decodeAccounts,
  decodeManifest,
  deploy,
  parseDeploymentArguments,
  recordGateway,
  remove,
  selectAccount,
  selectBindings,
  type CommandRequest,
  type DeploymentManifest,
} from "../setup/deployment.ts";

const account = { id: "account-1", name: "Example account" };
const cleaner = { empty: () => Promise.resolve() };

function copy(manifest: DeploymentManifest): DeploymentManifest {
  return structuredClone(manifest);
}

describe("Cloudflare deployment", () => {
  it("reads back each field of a stored manifest, with the origin of the last deploy", () => {
    const manifest = recordGateway(
      addVectorRetrieval(createManifest("karmi-playground-a1b2c3d4", account, {}, { isolateScripts: true })),
      "default",
    );
    manifest.origin = "https://karmi-playground-a1b2c3d4.example.workers.dev";
    expect(decodeManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() => decodeManifest({ version: 1, name: "x" })).toThrow("The deployment manifest is invalid.");
  });

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

  it("adds the Worker Loader binding only when the deployment selected isolate Scripts", () => {
    const base = { name: "karmi-playground", worker_loaders: [{ binding: "KARMI_LOADER" }] };
    const plain = createManifest("plain-deployment", account);
    expect(plain.isolateScripts).toBe(false);
    expect(selectBindings(base, plain)).toEqual({ name: "karmi-playground" });
    const scripts = createManifest("scripts-deployment", account, {}, { isolateScripts: true });
    expect(selectBindings(base, scripts)).toEqual(base);
  });

  it("adds the container sandbox only when the deployment selected container Scripts", () => {
    const base = {
      name: "karmi-playground",
      durable_objects: {
        bindings: [
          { name: "KARMI_THREADS", class_name: "ThreadDO" },
          { name: "KARMI_SANDBOX", class_name: "KarmiSandbox" },
        ],
      },
      migrations: [
        { tag: "karmi-v1", new_sqlite_classes: ["ThreadDO"] },
        { tag: "karmi-sandbox-v1", new_sqlite_classes: ["KarmiSandbox"] },
      ],
      containers: [{ class_name: "KarmiSandbox", image: "./Dockerfile", max_instances: 2 }],
    };
    const plain = createManifest("plain-deployment", account);
    expect(plain.container).toBeUndefined();
    expect(selectBindings(base, plain)).toEqual({
      name: "karmi-playground",
      durable_objects: { bindings: [{ name: "KARMI_THREADS", class_name: "ThreadDO" }] },
      migrations: [{ tag: "karmi-v1", new_sqlite_classes: ["ThreadDO"] }],
    });
    const containers = createManifest("box-deployment", account, {}, { containerScripts: true });
    expect(containers.container).toEqual({ name: "box-deployment-sandbox", owned: true, status: "pending" });
    expect(selectBindings(base, containers)).toMatchObject({
      durable_objects: base.durable_objects,
      migrations: base.migrations,
      // The name is the owned container application. Removal finds it and its images by this name.
      containers: [{ class_name: "KarmiSandbox", name: "box-deployment-sandbox", max_instances: 2 }],
    });
  });

  it("records the container application of a deployment and refuses one that existed before", async () => {
    const manifest = createManifest("karmi-playground-test-box", account, {}, { containerScripts: true });
    const calls: string[] = [];
    const saved: DeploymentManifest[] = [];
    const runner = (existing: string) => ({
      run(request: CommandRequest) {
        calls.push(request.args.join(" "));
        if (request.args[0] === "containers") return Promise.resolve(existing);
        if (request.args.includes("info") || request.args[0] === "deployments")
          return Promise.reject(new Error("not found"));
        return Promise.resolve("");
      },
    });
    const store = {
      save(current: DeploymentManifest) {
        saved.push(copy(current));
        return Promise.resolve();
      },
    };
    await expect(
      deploy(
        copy(manifest),
        {},
        "config.json",
        runner(JSON.stringify([{ id: "app-1", name: "karmi-playground-test-box-sandbox" }])),
        store,
      ),
    ).rejects.toThrow("is not owned by this deployment");
    calls.length = 0;
    await deploy(manifest, {}, "config.json", runner("[]"), store);
    expect(calls).toContain("containers list --json");
    expect(saved.some((current) => current.container?.status === "creating")).toBe(true);
    expect(manifest.container?.status).toBe("created");
  });

  it("removes the owned container application and its images after the Worker", async () => {
    const manifest = createManifest("karmi-playground-test-rm", account, {}, { containerScripts: true });
    manifest.worker.status = "created";
    if (!manifest.container) throw new Error("No container resource.");
    manifest.container.status = "created";
    const name = manifest.container.name;
    const calls: string[] = [];
    // The list names an image with the account in front of it. The second list is after the deletes.
    let images = [
      { name: `${account.id}/${name}`, tags: ["build-1", "build-2"] },
      { name: "other-app", tags: ["build-9"] },
    ];
    const result = await remove(
      manifest,
      {
        run(request) {
          const line = request.args.join(" ");
          calls.push(line);
          if (line === "containers list --json")
            return Promise.resolve(
              JSON.stringify([
                { id: "app-7", name },
                { id: "app-8", name: "other-app" },
              ]),
            );
          if (line === "containers images list --json") return Promise.resolve(JSON.stringify(images));
          if (line.includes("build-2")) images = images.filter((image) => image.name === "other-app");
          return Promise.resolve("");
        },
      },
      { save: () => Promise.resolve() },
      cleaner,
    );
    expect(result).toEqual({ complete: true, preserved: [] });
    expect(calls).toEqual([
      `delete ${manifest.worker.name} --force`,
      "containers list --json",
      "containers delete app-7",
      "containers images list --json",
      `containers images delete ${name}:build-1 --skip-confirmation`,
      `containers images delete ${name}:build-2 --skip-confirmation`,
      "containers images list --json",
    ]);
    expect(manifest.container.status).toBe("removed");
  });

  it("does not report removal while an image of the container application remains", async () => {
    const manifest = createManifest("karmi-playground-test-rm-image", account, {}, { containerScripts: true });
    if (!manifest.container) throw new Error("No container resource.");
    manifest.container.status = "created";
    const name = manifest.container.name;
    const result = await remove(
      manifest,
      {
        run(request) {
          if (request.args.join(" ") === "containers images list --json")
            return Promise.resolve(JSON.stringify([{ name, tags: ["build-1"] }]));
          return Promise.resolve(request.args[1] === "list" ? "[]" : "");
        },
      },
      { save: () => Promise.resolve() },
      cleaner,
    );
    expect(result).toMatchObject({ complete: false, failures: [{ resource: `container ${name}` }] });
    expect(manifest.container.status).toBe("created");
  });

  it("keeps the container application retryable when its removal fails", async () => {
    const manifest = createManifest("karmi-playground-test-rm-fail", account, {}, { containerScripts: true });
    if (!manifest.container) throw new Error("No container resource.");
    manifest.container.status = "created";
    const result = await remove(
      manifest,
      {
        run(request) {
          if (request.args[1] === "list")
            return Promise.resolve(JSON.stringify([{ id: "app-7", name: manifest.container?.name }]));
          return Promise.reject(new Error("Container delete failed"));
        },
      },
      { save: () => Promise.resolve() },
      cleaner,
    );
    expect(result).toMatchObject({
      complete: false,
      failures: [{ resource: `container ${manifest.container.name}`, message: "Container delete failed" }],
    });
    expect(manifest.container.status).toBe("created");
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
    const address = await deploy(
      manifest,
      { PROVIDER_API_KEY: "secret" },
      ".deployments/test/wrangler.jsonc",
      {
        run(request) {
          retryCalls.push(request);
          return Promise.resolve(
            request.args[0] === "deploy" ? "Uploaded\n  https://karmi-playground-test-a1b2.example.workers.dev\n" : "",
          );
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
    expect(address).toBe("https://karmi-playground-test-a1b2.example.workers.dev");
    // The next deploy gives the recorded origin to the Worker as PLAYGROUND_ORIGIN.
    expect(saved.at(-1)?.origin).toBe(address);
  });

  it("adds container Scripts to a deployment that exists already", () => {
    const manifest = createManifest("karmi-play", account);
    const added = addContainerScripts(manifest);
    expect(added.container).toEqual({ name: "karmi-play-sandbox", owned: true, status: "pending" });
    expect(manifest.container).toBeUndefined();
    expect(addContainerScripts(added)).toBe(added);
  });

  it("binds Workers AI and the Vectorize index only when the deployment selected vector retrieval", () => {
    const base = { name: "karmi-playground" };
    expect(selectBindings(base, createManifest("plain-deployment", account))).toEqual(base);
    const vectors = createManifest("vector-deployment", account, {}, { vectorRetrieval: true });
    expect(vectors.vectorIndex).toEqual({ name: "vector-deployment-vectors", owned: true, status: "pending" });
    expect(selectBindings(base, vectors)).toEqual({
      name: "karmi-playground",
      ai: { binding: "KARMI_AI" },
      vectorize: [{ binding: "KNOWLEDGE_VECTORS", index_name: "vector-deployment-vectors" }],
    });
    // A supplied index selects vector retrieval. The deployment does not own it.
    const supplied = createManifest(
      "shared-deployment",
      account,
      parseDeploymentArguments(["--vector-index", "shared-vectors"]).supplied,
    );
    expect(supplied.vectorIndex).toEqual({ name: "shared-vectors", owned: false, status: "created" });
    expect(addVectorRetrieval(supplied)).toBe(supplied);
    expect(addVectorRetrieval(createManifest("later", account)).vectorIndex?.name).toBe("later-vectors");
    // A resumed deployment can name an existing index in place of a new one.
    expect(addVectorRetrieval(createManifest("later", account), "shared-vectors").vectorIndex).toEqual({
      name: "shared-vectors",
      owned: false,
      status: "created",
    });
  });

  it("creates the Vectorize index with its metadata indexes and retries an interrupted creation", async () => {
    const manifest = createManifest("karmi-playground-test-vec", account, {}, { vectorRetrieval: true });
    const name = "karmi-playground-test-vec-vectors";
    const saved: DeploymentManifest[] = [];
    const store = {
      save(current: DeploymentManifest) {
        saved.push(copy(current));
        return Promise.resolve();
      },
    };
    const calls: string[] = [];
    // The first run stops after the index exists, before its second metadata index.
    let interrupt = true;
    const runner = {
      run(request: CommandRequest) {
        const line = request.args.join(" ");
        calls.push(line);
        if (line === `vectorize get ${name}`)
          return Promise.reject(new Error("vectorize.index.not_found [code: 3000]"));
        if (request.args.includes("info") || request.args[0] === "deployments")
          return Promise.reject(new Error("not found"));
        if (interrupt && line.includes("--propertyName=doc")) return Promise.reject(new Error("interrupted"));
        if (!interrupt && line.startsWith("vectorize create "))
          return Promise.reject(new Error(`vectorize.index.duplicate_name - Index name "${name}" [code: 3002]`));
        return Promise.resolve("");
      },
    };
    await expect(deploy(manifest, {}, "config.json", runner, store)).rejects.toThrow("interrupted");
    expect(calls).toContain(`vectorize create ${name} --dimensions=1024 --metric=cosine`);
    expect(calls).toContain(`vectorize create-metadata-index ${name} --propertyName=knowledge --type=string`);
    expect(saved.at(-1)?.vectorIndex?.status).toBe("creating");

    interrupt = false;
    calls.length = 0;
    await deploy(manifest, {}, "config.json", runner, store);
    // A retry does not ask again whether the index exists, because the record says that this deployment made it.
    expect(calls).not.toContain(`vectorize get ${name}`);
    expect(calls).toContain(`vectorize create-metadata-index ${name} --propertyName=doc --type=string`);
    expect(manifest.vectorIndex?.status).toBe("created");
  });

  it("refuses a Vectorize index that existed before the deploy, and checks a supplied one", async () => {
    const manifest = createManifest("karmi-playground-test-vec2", account, {}, { vectorRetrieval: true });
    const found = {
      run(request: CommandRequest) {
        if (request.args.includes("info") || request.args[0] === "deployments")
          return Promise.reject(new Error("not found"));
        return Promise.resolve("");
      },
    };
    const store = { save: () => Promise.resolve() };
    await expect(deploy(manifest, {}, "config.json", found, store)).rejects.toThrow(
      "vector index karmi-playground-test-vec2-vectors already exists and is not owned by this deployment",
    );
    expect(manifest.vectorIndex?.status).toBe("pending");

    // A supplied index must exist and have the shape and the metadata indexes that the Worker needs.
    const supplied = (name: string) => createManifest(name, account, { vectorIndex: "shared-vectors" });
    const answers = (shape: object | undefined, metadata: string[]) => ({
      run(request: CommandRequest) {
        const line = request.args.join(" ");
        if (line === "vectorize get shared-vectors --json")
          return shape
            ? Promise.resolve(JSON.stringify({ name: "shared-vectors", config: shape }))
            : Promise.reject(new Error("vectorize.index.not_found"));
        if (line === "vectorize list-metadata-index shared-vectors --json")
          return Promise.resolve(
            JSON.stringify(metadata.map((propertyName) => ({ propertyName, indexType: "String" }))),
          );
        return found.run(request);
      },
    });
    const good = { dimensions: 1024, metric: "cosine" };
    await expect(deploy(supplied("vec-missing"), {}, "config.json", answers(undefined, []), store)).rejects.toThrow(
      "not_found",
    );
    await expect(
      deploy(supplied("vec-shape"), {}, "config.json", answers({ dimensions: 768, metric: "cosine" }, []), store),
    ).rejects.toThrow("must have 1024 dimensions and the cosine metric");
    await expect(deploy(supplied("vec-meta"), {}, "config.json", answers(good, ["knowledge"]), store)).rejects.toThrow(
      "needs a string metadata index on doc",
    );
    const fits = supplied("vec-fits");
    fits.worker.status = "created";
    await deploy(fits, {}, "config.json", answers(good, ["knowledge", "doc"]), store);
    expect(fits.vectorIndex).toEqual({ name: "shared-vectors", owned: false, status: "created" });
  });

  it("deletes the owned Vectorize index after the Worker and preserves a supplied one", async () => {
    const owned = createManifest("karmi-playground-test-vrm", account, {}, { vectorRetrieval: true });
    owned.worker.status = "created";
    if (!owned.vectorIndex) throw new Error("No vector index.");
    owned.vectorIndex.status = "created";
    const calls: string[] = [];
    const runner = {
      run(request: CommandRequest) {
        calls.push(request.args.join(" "));
        return Promise.resolve("");
      },
    };
    const store = { save: () => Promise.resolve() };
    expect(await remove(owned, runner, store, cleaner)).toEqual({ complete: true, preserved: [] });
    expect(calls).toEqual([
      `delete ${owned.worker.name} --force`,
      `vectorize delete ${owned.vectorIndex.name} --force`,
    ]);
    expect(owned.vectorIndex.status).toBe("removed");

    const supplied = createManifest("karmi-playground-test-vkeep", account, { vectorIndex: "shared-vectors" });
    calls.length = 0;
    expect(await remove(supplied, runner, store, cleaner)).toEqual({
      complete: true,
      preserved: ["vectorIndex shared-vectors"],
    });
    expect(calls).toEqual([]);
  });

  it("records the AI Gateway of setup as supplied, and removal preserves it", async () => {
    const manifest = recordGateway(createManifest("karmi-playground-test-gw", account), "default");
    expect(manifest.gateway).toMatchObject({ name: "default", owned: false });
    // A later setup without a gateway leaves no stale record.
    expect(recordGateway(manifest, undefined).gateway).toBeUndefined();
    const calls: string[] = [];
    const runner = {
      run(request: CommandRequest) {
        calls.push(request.args.join(" "));
        return Promise.resolve("");
      },
    };
    expect(await remove(manifest, runner, { save: () => Promise.resolve() }, cleaner)).toEqual({
      complete: true,
      preserved: ["gateway default"],
    });
    expect(calls.some((call) => call.includes("gateway"))).toBe(false);
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
        cleaner,
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
      cleaner,
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
      cleaner,
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
        cleaner,
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
      cleaner,
    );
    expect(result).toMatchObject({
      complete: false,
      failures: [{ resource: `queue consumer ${manifest.worker.name}` }],
    });
    expect(calls).toHaveLength(1);
    expect(manifest.worker.status).toBe("created");
  });

  it("empties an owned bucket before it deletes the bucket", async () => {
    const manifest = createManifest("karmi-playground-test-bucket", account);
    manifest.bucket.status = "created";
    const steps: string[] = [];
    const result = await remove(
      manifest,
      {
        run(request) {
          steps.push(request.args.join(" "));
          return Promise.resolve("");
        },
      },
      { save: () => Promise.resolve() },
      {
        empty(accountId, bucket) {
          steps.push(`empty ${accountId} ${bucket}`);
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ complete: true, preserved: [] });
    expect(steps).toEqual([`empty ${account.id} ${manifest.bucket.name}`, `r2 bucket delete ${manifest.bucket.name}`]);
  });

  it("keeps the bucket retryable when emptying it fails", async () => {
    const manifest = createManifest("karmi-playground-test-bucket-fail", account);
    manifest.bucket.status = "created";
    const calls: CommandRequest[] = [];
    const result = await remove(
      manifest,
      {
        run(request) {
          calls.push(request);
          return Promise.resolve("");
        },
      },
      { save: () => Promise.resolve() },
      { empty: () => Promise.reject(new Error("Delete failed")) },
    );
    expect(result).toEqual({
      complete: false,
      preserved: [],
      failures: [{ resource: `bucket ${manifest.bucket.name}`, message: "Delete failed" }],
    });
    expect(calls).toEqual([]);
    expect(manifest.bucket.status).toBe("created");
  });
});
