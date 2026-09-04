/** The one wildcard karmi understands: `*` matches any run of characters, everything else is literal. */
export function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}
