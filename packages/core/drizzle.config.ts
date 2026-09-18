import { defineConfig } from "drizzle-kit";

const database = process.env.KARMI_DATABASE;

if (!database) throw new Error("KARMI_DATABASE must name the Durable Object database to generate.");

export default defineConfig({
  dialect: "sqlite",
  schema: `./src/db/${database}/schema.ts`,
  out: `./src/db/${database}/migrations`,
});
