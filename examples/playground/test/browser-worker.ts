import { createKarmi } from "@karmi/core";
import { fakeProvider } from "@karmi/core/testing";
import { env } from "cloudflare:workers";
import { createPlayground } from "../src/app";
import { catalogue } from "../src/catalogue";
import { playgroundLogger } from "../src/observability";
import { CONTAINER_IMAGE } from "../src/containers";
import { fakeContainer } from "./container-driver";
import { playgroundReplies } from "./script";
import { setup, TOKEN } from "./worker-options";

// The Worker of the browser checks. `wrangler dev` runs it, where `createTestKarmi` cannot run, so it registers
// the scripted Provider itself.
const karmi = createKarmi({
  catalogue: catalogue("fake/model"),
  logger: playgroundLogger(),
  providers: { fake: fakeProvider(playgroundReplies) },
  defaults: { providers: { default: { adapter: "fake", models: ["*"] } } },
  sandbox: { image: CONTAINER_IMAGE, driver: fakeContainer },
});

const playground = createPlayground({
  karmi,
  model: "fake/model",
  setup,
  token: TOKEN,
  data: env.PLAYGROUND_DATA,
  media: env.KARMI_MEDIA,
  hasLoader: env.KARMI_LOADER !== undefined,
  containers: "docker",
});

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "../src/sample-data";

export default {
  fetch: playground.fetch,
  queue: karmi.queueHandler,
  scheduled: (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) =>
    ctx.waitUntil(playground.supplierDelivery(controller.scheduledTime)),
};
