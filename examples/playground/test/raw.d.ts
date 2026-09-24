// Vite serves a `?raw` import as the text of the file. The walkthrough and replay tests read files this way.
declare module "*?raw" {
  const contents: string;
  export default contents;
}

// Vite finds the files of a pattern at build time. The walkthrough test checks that a file of a command exists.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
