// Vite serves a `?raw` import as the file's text; the doctor test reads wrangler.jsonc and the Worker entry.
declare module "*?raw" {
  const contents: string;
  export default contents;
}
