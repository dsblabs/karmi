import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ownVersion, scaffold } from "../src/index";

let directory: string;
beforeEach(async () => {
  directory = join(await mkdtemp(join(tmpdir(), "create-karmi-")), "my-agent");
});

const read = (project: { directory: string }, file: string) => readFile(join(project.directory, file), "utf8");

describe("scaffold", () => {
  it("writes the whole template", async () => {
    const project = await scaffold({ directory });
    expect(project.files).toContain("src/worker.ts");
    expect(project.files).toContain("test/agent.test.ts");
    expect(project.files).toContain("wrangler.jsonc");
    expect(project.files).toContain(".github/workflows/ci.yml");
  });

  it("names the project after its directory", async () => {
    const project = await scaffold({ directory });
    expect(project.name).toBe("my-agent");
    expect(JSON.parse(await read(project, "package.json")).name).toBe("my-agent");
    expect(await read(project, "wrangler.jsonc")).toContain('"name": "my-agent"');
    expect(await read(project, "wrangler.jsonc")).toContain("my-agent-queue");
  });

  it("takes an explicit name over the directory's", async () => {
    const project = await scaffold({ directory, name: "concierge" });
    expect(JSON.parse(await read(project, "package.json")).name).toBe("concierge");
  });

  it("depends on published karmi versions, never the workspace links it develops against", async () => {
    const project = await scaffold({ directory, version: "1.2.3" });
    const { dependencies } = JSON.parse(await read(project, "package.json"));
    expect(dependencies).toMatchObject({ "@karmi/core": "^1.2.3", "@karmi/http": "^1.2.3" });
    expect(await read(project, "package.json")).not.toContain("workspace:");
  });

  it("defaults the version to its own", async () => {
    expect((await scaffold({ directory })).version).toBe(await ownVersion());
  });

  it("restores the leading dot npm would strip from .gitignore", async () => {
    const project = await scaffold({ directory });
    expect(project.files).toContain(".gitignore");
    expect(project.files).not.toContain("gitignore");
    expect(await read(project, ".gitignore")).toContain("node_modules/");
  });

  it("leaves a build of the template behind", async () => {
    const from = join(directory, "..", "template");
    await mkdir(join(from, "dist"), { recursive: true });
    await writeFile(join(from, "dist", "worker.js"), "built");
    await writeFile(join(from, "keep.txt"), "kept");
    const project = await scaffold({ directory, templateDir: from });
    expect(project.files).toEqual(["keep.txt"]);
  });

  it("refuses a name that is not a Worker name", async () => {
    await expect(scaffold({ directory, name: "My Agent" })).rejects.toThrowError("lower-case");
  });

  it("refuses a directory that already holds files", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "README.md"), "mine");
    await expect(scaffold({ directory })).rejects.toThrowError("not empty");
    expect(await readdir(directory)).toEqual(["README.md"]);
  });
});
