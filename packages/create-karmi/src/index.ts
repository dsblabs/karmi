import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The scaffolder copies the template, rewrites the two things that are project-specific — its name and the
// karmi version it depends on — and writes the result. Everything else is the template verbatim.

/** The name the template carries wherever a project's own name belongs. */
const TEMPLATE_NAME = "karmi-template";
/** Directories never copied out of the template, whatever a local template directory happens to hold. */
const SKIPPED = new Set(["node_modules", "dist", ".wrangler", ".turbo"]);
/** A file the template must ship under a leading dot, which npm would otherwise rename on publish. */
const DOTTED: Record<string, string> = { gitignore: ".gitignore" };

const NAME = /^[a-z0-9][a-z0-9-]{0,53}$/;

/** Options for `scaffold`. */
export interface ScaffoldOptions {
  /** Where the project is written. It is created when absent and must be empty otherwise. */
  directory: string;
  /** The project's name, used for the package, the Worker and its Queue and bucket. Defaults to the directory's name. */
  name?: string;
  /** The `@karmi/*` version the project depends on. Defaults to this package's own version. */
  version?: string;
  /** Where the template is read from. Defaults to the copy shipped in this package. */
  templateDir?: string;
}

/** What `scaffold` wrote. */
export interface Scaffolded {
  /** The absolute path of the project directory. */
  directory: string;
  /** Every file written, relative to `directory`, in the order they were written. */
  files: string[];
  name: string;
  version: string;
}

/** This package's own version, which is also the `@karmi/*` version a scaffolded project depends on. */
export async function ownVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
  if (typeof version !== "string") throw new Error("create-karmi has no version of its own.");
  return version;
}

/**
 * Writes a new karmi project into `options.directory`. Throws when the name is not a valid Worker name or
 * the directory already holds files. It never installs dependencies and never runs git.
 */
export async function scaffold(options: ScaffoldOptions): Promise<Scaffolded> {
  const directory = resolve(options.directory);
  const name = options.name ?? basename(directory);
  if (!NAME.test(name))
    throw new Error(`"${name}" is not a usable project name: use lower-case letters, digits and dashes.`);
  const existing = await readdir(directory).catch(() => []);
  if (existing.length > 0) throw new Error(`${directory} is not empty.`);
  const version = options.version ?? (await ownVersion());
  const from = options.templateDir ?? fileURLToPath(new URL("../template", import.meta.url));
  const files: string[] = [];
  for (const relative of await templateFiles(from)) {
    const target = join(directory, rename(relative));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, personalize(await readFile(join(from, relative), "utf8"), name, version));
    files.push(rename(relative));
  }
  return { directory, files, name, version };
}

/** Every template file, relative to `from`, depth first and in directory order. */
async function templateFiles(from: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(from, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await templateFiles(from, relative)));
    else files.push(relative);
  }
  return files;
}

const rename = (relative: string): string => {
  const parts = relative.split("/");
  const last = parts[parts.length - 1] ?? "";
  return DOTTED[last] === undefined ? relative : [...parts.slice(0, -1), DOTTED[last]].join("/");
};

/**
 * The template's text with the project's name in place of the template's, and a published karmi version in
 * place of the workspace link the template develops against.
 */
function personalize(contents: string, name: string, version: string): string {
  return contents.split(TEMPLATE_NAME).join(name).split('"workspace:*"').join(`"^${version}"`);
}
