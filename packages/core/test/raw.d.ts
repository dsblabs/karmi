// Vite serves a `?raw` import as the file's text; the doctor tests read the shipped wrangler baseline that way.
declare module "*?raw" {
  const contents: string;
  export default contents;
}
