# karmi-template

This project is a karmi Deployment. It contains these parts:

- One sample Tool and one sample Agent.
- REST, SSE and WebSocket routes.
- A cron and a Queue consumer.
- A test suite that runs the full Deployment with a scripted model.

Run these commands to install the packages and test the project:

```sh
pnpm install
pnpm typecheck && pnpm test
```

`pnpm test` runs `karmi doctor` first. Thus a Worker with an incorrect configuration fails before the suite starts.

## Files

| File               | Contents                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `src/catalogue.ts` | The Tools and Agents this Deployment defines in code.                           |
| `src/worker.ts`    | `createKarmi`, the HTTP routes, the Durable Object re-exports and the handlers. |
| `src/triggers.ts`  | The cron and Queue handlers. They use the Thread API.                           |
| `wrangler.jsonc`   | The karmi wrangler baseline. `karmi doctor` checks it.                          |
| `test/worker.ts`   | The same Catalogue in `createTestKarmi`, with a scripted Provider.              |

## Deploy

1. Create the Queue, its dead-letter Queue and the R2 bucket that `wrangler.jsonc` names:

   ```sh
   npx wrangler queues create karmi-template-queue
   npx wrangler queues create karmi-template-dlq
   npx wrangler r2 bucket create karmi-template-media
   ```

2. Set the two secrets. `KARMI_KEYRING` encrypts each credential that a Scope stores. `API_TOKEN` is the
   bearer token that the sample `authenticate` function accepts.

   ```sh
   node -e "import('@karmi/core').then(k => console.log(k.generateKeyringKey()))" | npx wrangler secret put KARMI_KEYRING
   npx wrangler secret put API_TOKEN
   ```

3. Deploy the Worker:

   ```sh
   pnpm run deploy
   ```

4. Give the `demo` Scope an Anthropic key. Its Agents cannot run without the key:

   ```ts
   await karmi.scope("demo").credentials.put({ name: "anthropic", value: process.env.ANTHROPIC_API_KEY });
   ```

## Send a message to an Agent

These commands create a Thread, send a message and read the Thread events:

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
