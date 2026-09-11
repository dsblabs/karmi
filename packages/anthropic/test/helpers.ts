import type { Provider, ProviderCallOptions, ProviderEvent, ProviderRequest } from "@karmi/core";

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface Served {
  calls: Seen[];
  fetch: typeof fetch;
}

type Answer =
  | { sse: string; headers?: Record<string, string> }
  | { status: number; json: unknown; headers?: Record<string, string> };

/** A transport that answers each call from its script in order and records what it received. */
export function serve(...answers: Answer[]): Served {
  const calls: Seen[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    calls.push({
      url: request.url,
      method: request.method,
      headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (!answer) return new Response("no script", { status: 500 });
    if ("sse" in answer)
      return new Response(answer.sse, {
        status: 200,
        headers: { "content-type": "text/event-stream", ...answer.headers },
      });
    return Response.json(answer.json, { status: answer.status, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return { calls, fetch: stub };
}

export const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "claude-sonnet-5",
  config: { adapter: "anthropic" },
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  ...overrides,
});

export async function collect(
  provider: Provider,
  req: ProviderRequest,
  options: Partial<ProviderCallOptions> & { fetch: typeof fetch },
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(req, { signal: new AbortController().signal, ...options }))
    events.push(event);
  return events;
}
