import { describe, expect, it } from "vitest";
import knowledgeMigrations from "../src/db/knowledge/migrations";
import memoryMigrations from "../src/db/memory/migrations";
import scopeConfigMigrations from "../src/db/scope-config/migrations";
import threadMigrations from "../src/db/thread/migrations";
import { expectMigrationSchema } from "./migration-fixtures";

const migrationModules = import.meta.glob("../src/db/*/migrations/index.ts", {
  eager: true,
  import: "default",
});
const schemas = import.meta.glob("../src/db/*/schema.ts", { eager: true });
const journals = import.meta.glob("../src/db/*/migrations/meta/_journal.json", {
  eager: true,
  import: "default",
  query: "?raw",
});
const sqlFiles = import.meta.glob("../src/db/*/migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("committed migrations", () => {
  it("keeps every inlined module equal to its journal and SQL files", () => {
    for (const schemaPath of Object.keys(schemas)) {
      const directory = `${schemaPath.slice(0, -"schema.ts".length)}migrations/`;
      const module = migrationModules[`${directory}index.ts`];
      expect(module, `${directory} is missing its inlined module`).toBeDefined();
      const journalSource = journals[`${directory}meta/_journal.json`];
      expect(journalSource, `${directory} is missing its journal`).toBeTypeOf("string");
      const journal = JSON.parse(String(journalSource)) as {
        entries: { idx: number; tag: string }[];
      };
      const migrations = Object.fromEntries(
        journal.entries.map(({ idx, tag }) => [`m${String(idx).padStart(4, "0")}`, sqlFiles[`${directory}${tag}.sql`]]),
      );
      expect(
        Object.keys(sqlFiles)
          .filter((path) => path.startsWith(directory))
          .sort(),
      ).toEqual(journal.entries.map(({ tag }) => `${directory}${tag}.sql`).sort());
      expect(module).toEqual({ journal: JSON.parse(String(journalSource)), migrations });
    }
  });

  it("migrates an empty Knowledge database exactly once", async () => {
    await expectMigrationSchema(knowledgeMigrations, "Knowledge sqlite_master");
  });

  it("migrates an empty Memory database exactly once", async () => {
    await expectMigrationSchema(memoryMigrations, "Memory sqlite_master");
  });

  it("migrates an empty Scope config database exactly once", async () => {
    await expectMigrationSchema(scopeConfigMigrations, "Scope config sqlite_master");
  });

  it("migrates an empty Thread database exactly once", async () => {
    await expectMigrationSchema(threadMigrations, "Thread sqlite_master");
  });
});
