// Vite serves a `?raw` import as the file's text; the doctor tests read the shipped wrangler baseline that way.
declare module "*?raw" {
  const contents: string;
  export default contents;
}

interface ImportMeta {
  glob(pattern: string, options: { eager: true; import?: string; query?: string }): Record<string, unknown>;
}
