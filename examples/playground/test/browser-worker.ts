import { createKarmi } from "@karmi/core";
import { fakeProvider } from "@karmi/core/testing";
import { env } from "cloudflare:workers";
import { createPlayground } from "../src/app";
import { catalogue } from "../src/refund";
import { refundReplies } from "./script";
import { setup, TOKEN } from "./worker-options";

// The Worker of the browser checks. `wrangler dev` runs it, where `createTestKarmi` cannot run, so it registers
// the scripted Provider itself.
const karmi = createKarmi({
  catalogue: catalogue("fake/model"),
  providers: { fake: fakeProvider(refundReplies) },
  defaults: { providers: { default: { adapter: "fake", models: ["*"] } } },
});

const playground = createPlayground({ karmi, setup, token: TOKEN, data: env.PLAYGROUND_DATA });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "../src/sample-data";

export default { fetch: playground.fetch, queue: karmi.queueHandler };
