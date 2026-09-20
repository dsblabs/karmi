// Generates the root `llms.txt` from the page list in `docs/guide/README.md`.
// Run `pnpm docs:llms` to write the file. Run it with `--check` to fail when the file is out of date.
import { readFileSync, writeFileSync } from "node:fs";

// A docs site changes this one line.
const baseUrl = "https://raw.githubusercontent.com/dsblabs/karmi/main/";

const indexPath = new URL("../docs/guide/README.md", import.meta.url);
const outputPath = new URL("../llms.txt", import.meta.url);

/** Reads the title, the file name and the description of each numbered page in the guide index. */
function parseGuideIndex(markdown) {
  const pages = [];
  for (const line of markdown.split("\n")) {
    const entry = /^\d+\. \[(.+?)\]\(\.\/(.+?\.md)\) (.+)$/.exec(line);
    if (entry) pages.push({ title: entry[1], file: entry[2], description: entry[3] });
  }
  return pages;
}

function render(pages) {
  const lines = [
    "# karmi",
    "",
    "> karmi is a code-first TypeScript framework. You use it to build agent harnesses that run natively on a serverless runtime.",
    "",
    "The guide shows the public API only. The terms with capitals, for example Thread and Scope, are in the glossary.",
    "",
    "## Guide",
    "",
    ...pages.map(
      ({ title, file, description }) => `- [${title}](${baseUrl}docs/guide/${file}): ${title} ${description}`,
    ),
    "",
    "## Glossary",
    "",
    `- [Glossary](${baseUrl}CONTEXT.md): The glossary defines each karmi term that the guide uses.`,
    "",
  ];
  return lines.join("\n");
}

const pages = parseGuideIndex(readFileSync(indexPath, "utf8"));
if (pages.length === 0) {
  console.error("docs/guide/README.md has no numbered page entries.");
  process.exit(1);
}
const output = render(pages);

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(outputPath, "utf8");
  } catch {
    // A missing file is out of date.
  }
  if (committed !== output) {
    console.error("llms.txt is out of date. Run `pnpm docs:llms` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, output);
}
