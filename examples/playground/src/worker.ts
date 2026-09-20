import { createKarmi } from "@karmi/core";
import { env } from "cloudflare:workers";
import { createPlayground } from "./app";
import { readSetup } from "./provider-options";
import { ADAPTER, buildProvider } from "./providers";
import { catalogue } from "./refund";

// `pnpm setup` writes the selection and the credential to `.dev.vars`. Without it, the Playground still starts
// and tells the operator what is missing.
const apiKey = env.PROVIDER_API_KEY;
const setup = apiKey ? readSetup(env) : undefined;

const karmi = createKarmi({
  catalogue: catalogue(`${ADAPTER}/${setup?.model ?? "none"}`),
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

const playground = createPlayground({ karmi, setup, token: env.PLAYGROUND_TOKEN, data: env.PLAYGROUND_DATA });

/** The Durable Object classes of karmi that wrangler.jsonc names. */
export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "./sample-data";

export default { fetch: playground.fetch, queue: karmi.queueHandler };
