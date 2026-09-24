import { createKarmi } from "@karmi/core";
import { env } from "cloudflare:workers";
import { createPlayground } from "./app";
import { deploymentProviders, profilesOf } from "./providers";
import { catalogue } from "./catalogue";
import { playgroundLogger } from "./observability";
import { CONTAINER_IMAGE, containerRuntime } from "./containers";
import { keyringView } from "./keyring";
import { CLIENT_NAME, oauthSetup } from "./remote-mcp";
import { semanticRetriever, vectorizeIndex } from "./vectors";

// `pnpm setup` writes the selection and the credential to `.dev.vars`. Without it, the Playground still starts
// and tells the operator what is missing.
const deployment = deploymentProviders(env);
const setup = deployment?.setup;
const profiles = deployment?.choices ?? [];

// Each Agent of the other scenarios uses the `default` profile, which is the first choice.
const model = profiles[0]?.model ?? "none/none";

// `pnpm dev:containers` and a deployment with container Scripts set this variable. Without it, the KARMI_SANDBOX
// binding has no container behind it, thus the Worker offers no container Scripts.
const containers = containerRuntime(env.PLAYGROUND_CONTAINERS);

// The OAuth Connections of the MCP scenario need the public https origin of the Worker. Without it, the scenario
// still registers a server with no credential or with a static header.
const oauth = oauthSetup(env.PLAYGROUND_ORIGIN);

// A deployment that selected vector retrieval has Workers AI and a Vectorize index. Local development has neither,
// because Cloudflare has no local simulation of them. The Retriever then fails with bindings.missing.
const vectors = env.KARMI_AI && env.KNOWLEDGE_VECTORS ? vectorizeIndex(env.KNOWLEDGE_VECTORS) : undefined;

const karmi = createKarmi({
  catalogue: catalogue(model, semanticRetriever(vectors)),
  logger: playgroundLogger(),
  ...(containers && { sandbox: { image: CONTAINER_IMAGE } }),
  ...("origin" in oauth && { oauth: { origin: oauth.origin, clientName: CLIENT_NAME } }),
  ...(deployment && {
    providers: deployment.providers,
    // A profile names each credential, never a value.
    credentials: deployment.credentials,
    defaults: { providers: profilesOf(profiles) },
  }),
});

const playground = createPlayground({
  karmi,
  model,
  setup,
  profiles,
  token: env.PLAYGROUND_TOKEN,
  data: env.PLAYGROUND_DATA,
  media: env.KARMI_MEDIA,
  keyring: keyringView(env.KARMI_KEYRING),
  hasLoader: env.KARMI_LOADER !== undefined,
  containers,
  vectors,
  oauth,
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
