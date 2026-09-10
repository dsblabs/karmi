declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY: string;
  }
}

declare module "*.sse?raw" {
  const text: string;
  export default text;
}
