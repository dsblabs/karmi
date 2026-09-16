# karmi-template

A karmi Deployment: one sample Tool, one sample Agent, REST/SSE/WebSocket routes, a cron and a Queue
consumer, and a test suite that runs the whole thing against a scripted model.

```sh
pnpm install
pnpm typecheck && pnpm test
```

`pnpm test` runs `karmi doctor` first, so a misconfigured Worker fails before the suite does.

## What is where

| File               | What it holds                                                                   |
| ------------------ | ------------------------------------------------------------------------------- |
| `src/catalogue.ts` | The Tools and Agents this Deployment defines in code.                            |
| `src/worker.ts`    | `createKarmi`, the HTTP routes, the Durable Object re-exports and the handlers.  |
| `src/triggers.ts`  | The cron and Queue work, written over the Thread API.                            |
| `wrangler.jsonc`   | The karmi wrangler baseline. `karmi doctor` checks it.                           |
| `test/worker.ts`   | The same Catalogue under `createTestKarmi`, with a scripted Provider.            |

## Deploying

1. Create the Queue and its dead-letter Queue, and the R2 bucket named in `wrangler.jsonc`:

   ```sh
   npx wrangler queues create karmi-template-queue
   npx wrangler queues create karmi-template-dlq
   npx wrangler r2 bucket create karmi-template-media
   ```

2. Set the two secrets. `KARMI_KEYRING` encrypts every credential a Scope stores, and `API_TOKEN` is the
   bearer token the sample `authenticate` accepts.

   ```sh
   node -e "import('@karmi/core').then(k => console.log(k.generateKeyringKey()))" | npx wrangler secret put KARMI_KEYRING
   npx wrangler secret put API_TOKEN
   ```

3. Deploy, then give the `demo` Scope an Anthropic key so its Agents can run:

   ```sh
   pnpm deploy
   ```

   ```ts
   await karmi.scope("demo").credentials.put({ name: "anthropic", value: process.env.ANTHROPIC_API_KEY });
   ```

## Talking to an Agent

```sh
curl -X POST https://<your-worker>/threads \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"agent":"concierge"}'

curl -X POST https://<your-worker>/threads/<key>/turns \
  -H "authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"kind":"message","parts":[{"type":"text","text":"What is the weather in Paris?"}]}'

curl -N https://<your-worker>/threads/<key>/events \
  -H "authorization: Bearer $API_TOKEN" -H "accept: text/event-stream"
```
