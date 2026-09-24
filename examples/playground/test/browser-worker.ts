import { createKarmi } from "@karmi/core";
import { fakeProvider, routeFetch } from "@karmi/core/testing";
import { env } from "cloudflare:workers";
import { createPlayground } from "../src/app";
import { catalogue } from "../src/catalogue";
import { semanticRetriever } from "../src/vectors";
import { memoryIndex, topicEmbedder } from "./vector-index";
import { playgroundLogger } from "../src/observability";
import { CONTAINER_IMAGE } from "../src/containers";
import { fakeContainer } from "./container-driver";
import { keyringView } from "../src/keyring";
import { playgroundReplies } from "./script";
import { MCP_SERVERS } from "./mcp-servers";
import { oauthSetup } from "../src/remote-mcp";
import { PROFILE_CONFIGS, PROFILES } from "./profiles";
import { setup, TOKEN } from "./worker-options";

const scripted = fakeProvider(playgroundReplies);

// The Worker of the browser checks. `wrangler dev` runs it, where `createTestKarmi` cannot run, so it registers
// the scripted Provider itself.
const karmi = createKarmi({
  catalogue: catalogue("fake/model", semanticRetriever(memoryIndex, topicEmbedder)),
  logger: playgroundLogger(),
  // The profiles of the Provider scenario name the adapters `anthropic` and `ai-sdk`. The same scripted Provider
  // serves them.
  providers: { fake: scripted, anthropic: scripted, "ai-sdk": scripted },
  defaults: { providers: PROFILE_CONFIGS },
  sandbox: { image: CONTAINER_IMAGE, driver: fakeContainer },
  // The MCP scenario reaches the fake servers of the Test kit. The browser cannot reach their consent pages, thus
  // the browser checks use the server with no credential, and the Worker tests cover OAuth.
  fetch: routeFetch(MCP_SERVERS),
});

const playground = createPlayground({
  karmi,
  model: "fake/model",
  setup,
  profiles: PROFILES,
  token: TOKEN,
  data: env.PLAYGROUND_DATA,
  media: env.KARMI_MEDIA,
  keyring: keyringView(env.KARMI_KEYRING),
  hasLoader: env.KARMI_LOADER !== undefined,
  containers: "docker",
  vectors: memoryIndex,
  oauth: oauthSetup(undefined),
});

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "../src/sample-data";

export default {
  fetch: playground.fetch,
  queue: karmi.queueHandler,
  scheduled: (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) =>
    ctx.waitUntil(playground.supplierDelivery(controller.scheduledTime)),
};
