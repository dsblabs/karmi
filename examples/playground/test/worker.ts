import { createTestKarmi } from "@karmi/core/testing";
import { env } from "cloudflare:workers";
import { createPlayground } from "../src/app";
import { refundReplies } from "./script";
import { setup, TOKEN } from "./worker-options";
import { catalogue } from "../src/catalogue";
import { playgroundLogger } from "../src/observability";
import { CONTAINER_IMAGE } from "../src/containers";
import { fakeContainer } from "./container-driver";

// The test Worker runs the same routes, Tools and Agent as src/worker.ts against a scripted Provider, so no
// test needs a credential or a network.
export const { karmi, provider, clock } = createTestKarmi(catalogue("fake/model"), {
  logger: playgroundLogger(),
  // The container Scripts scenario runs on a fake container runtime. The Harness and the Workspace are real.
  sandbox: { image: CONTAINER_IMAGE, driver: fakeContainer },
});

/** Starts the script of the guided refund again. */
export const refundScript = () => provider.script(refundReplies);
refundScript();

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
/** The same routes before `pnpm setup` ran: no Provider and no access token. */
export const bare = createPlayground({
  karmi,
  model: "fake/model",
  setup: undefined,
  token: undefined,
  data: env.PLAYGROUND_DATA,
  media: env.KARMI_MEDIA,
  hasLoader: env.KARMI_LOADER !== undefined,
});

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "../src/sample-data";

export default {
  fetch: playground.fetch,
  queue: karmi.queueHandler,
  scheduled: (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) =>
    ctx.waitUntil(playground.supplierDelivery(controller.scheduledTime)),
};
