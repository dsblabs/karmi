// Generates the Vale rule `.vale/styles/Karmi/Terms.yml` from the `_Avoid_` lines in `CONTEXT.md`.
// Run `pnpm prose:terms` to write the rule. Run it with `--check` to fail when the rule is out of date.
import { readFileSync, writeFileSync } from "node:fs";

const contextPath = new URL("../CONTEXT.md", import.meta.url);
const rulePath = new URL("../.vale/styles/Karmi/Terms.yml", import.meta.url);

/** Reads each glossary term and the words that CONTEXT.md tells writers to avoid for it. */
function parseGlossary(markdown) {
  const entries = [];
  let term;
  for (const line of markdown.split("\n")) {
    const heading = /^\*\*(.+?)\*\*:\s*$/.exec(line);
    if (heading) term = heading[1];
    const avoid = /^_Avoid_:\s*(.+)$/.exec(line);
    if (avoid && term) entries.push({ term, avoid: splitAvoidList(avoid[1]) });
  }
  return entries;
}

/** Splits an `_Avoid_` list on commas that are outside parentheses. */
function splitAvoidList(text) {
  const items = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else current += char;
  }
  items.push(current.trim());
  return items.filter((item) => item.length > 0);
}

// A phrase is only safe to flag when it has one replacement in all contexts.
// A single word such as "run" or "provider" also has a plain English meaning, so the rule skips it.
// An avoided phrase with a qualifier in parentheses, or with a code span, depends on context.
// An avoided phrase that is also a glossary term, or that CONTEXT.md avoids for two terms, is ambiguous.
function buildSwaps(entries) {
  const terms = new Set(entries.map((entry) => entry.term.toLowerCase()));
  const owners = new Map();
  for (const { term, avoid } of entries) {
    for (const word of avoid) {
      if (/[(`]/.test(word) || !/\s/.test(word)) continue;
      const key = word.toLowerCase();
      owners.set(key, [...(owners.get(key) ?? []), term]);
    }
  }
  const swaps = [];
  for (const [word, owner] of owners) {
    if (owner.length !== 1 || terms.has(word)) continue;
    swaps.push([word, owner[0]]);
  }
  return swaps.sort(([a], [b]) => a.localeCompare(b));
}

function render(swaps) {
  const lines = [
    "# Generated from the _Avoid_ lines in CONTEXT.md by scripts/vale-terms.mjs. Do not edit.",
    "# Run `pnpm prose:terms` after a change to CONTEXT.md.",
    "extends: substitution",
    "message: \"Use the karmi term '%s' instead of '%s'.\"",
    "level: error",
    "ignorecase: true",
    "swap:",
    ...swaps.map(([word, term]) => `  '${escapeRegex(word)}': ${term}`),
    "",
  ];
  return lines.join("\n");
}

function escapeRegex(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "''");
}

const rule = render(buildSwaps(parseGlossary(readFileSync(contextPath, "utf8"))));

if (process.argv.includes("--check")) {
  if (readFileSync(rulePath, "utf8") !== rule) {
    console.error("Terms.yml is out of date. Run `pnpm prose:terms` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(rulePath, rule);
}
