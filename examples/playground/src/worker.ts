import { createKarmi } from "@karmi/core";
import { env } from "cloudflare:workers";
import { createPlayground } from "./app";
import { readSetup } from "./provider-options";
import { ADAPTER, buildProvider } from "./providers";
import { catalogue } from "./catalogue";
import { playgroundLogger } from "./observability";
import { CONTAINER_IMAGE, containerRuntime } from "./containers";

// `pnpm setup` writes the selection and the credential to `.dev.vars`. Without it, the Playground still starts
// and tells the operator what is missing.
const apiKey = env.PROVIDER_API_KEY;
const setup = apiKey ? readSetup(env) : undefined;

const model = `${ADAPTER}/${setup?.model ?? "none"}`;

// `pnpm dev:containers` and a deployment with container Scripts set this variable. Without it, the KARMI_SANDBOX
// binding has no container behind it, thus the Worker offers no container Scripts.
const containers = containerRuntime(env.PLAYGROUND_CONTAINERS);

const karmi = createKarmi({
  catalogue: catalogue(model),
  logger: playgroundLogger(),
  ...(containers && { sandbox: { image: CONTAINER_IMAGE } }),
  ...(setup &&
    apiKey && {
      providers: { [ADAPTER]: buildProvider(setup) },
      // The credential is a name in the profile, never a value.
      credentials: { provider: apiKey },
      defaults: {
        providers: {
          default: {
            adapter: ADAPTER,
            credential: "deployment:provider",
            ...(setup.baseUrl && { baseUrl: setup.baseUrl }),
          },
        },
      },
    }),
});

const playground = createPlayground({
  karmi,
  model,
  setup,
  token: env.PLAYGROUND_TOKEN,
  data: env.PLAYGROUND_DATA,
  media: env.KARMI_MEDIA,
  hasLoader: env.KARMI_LOADER !== undefined,
  containers,
});

/** The Durable Object classes of karmi that wrangler.jsonc names. */
export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "./sample-data";
/** The container sandbox and its outbound proxy. `wrangler.jsonc` names the sandbox; the proxy applies egress rules. */
export { KarmiSandbox, ContainerProxy } from "@karmi/core";

export default {
  fetch: playground.fetch,
  queue: karmi.queueHandler,
  // The external trigger of the Schedules scenario. wrangler.jsonc has no cron, thus no deployment calls the model
  // on a timer. The README tells how to call this handler.
  scheduled: (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) =>
    ctx.waitUntil(playground.supplierDelivery(controller.scheduledTime)),
};
