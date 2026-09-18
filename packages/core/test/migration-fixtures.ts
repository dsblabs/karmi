import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { expect } from "vitest";

type Migrations = Parameters<typeof migrate>[1];

/** Applies migrations twice to an empty database and snapshots its resulting SQLite objects. */
export const expectMigrationSchema = async (migrations: Migrations, snapshot: string): Promise<void> => {
  const stub = env.KARMI_MIGRATION_TEST.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, state) => {
    const db = drizzle(state.storage);
    await migrate(db, migrations);
    await migrate(db, migrations);
    const objects = state.storage.sql
      .exec<{ name: string; sql: string; type: string }>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .toArray();
    expect(objects).toMatchSnapshot(snapshot);
  });
};
