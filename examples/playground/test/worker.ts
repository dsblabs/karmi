import { createTestKarmi } from "@karmi/core/testing";
import { env } from "cloudflare:workers";
import { createPlayground } from "../src/app";
import { refundReplies } from "./script";
import { setup, TOKEN } from "./worker-options";
import { catalogue } from "../src/refund";

// The test Worker runs the same routes, Tools and Agent as src/worker.ts against a scripted Provider, so no
// test needs a credential or a network.
export const { karmi, provider } = createTestKarmi(catalogue("fake/model"));

/** Starts the script of the guided refund again. */
export const refundScript = () => provider.script(refundReplies);
refundScript();

const playground = createPlayground({ karmi, setup, token: TOKEN, data: env.PLAYGROUND_DATA });
/** The same routes before `pnpm setup` ran: no Provider and no access token. */
export const bare = createPlayground({ karmi, setup: undefined, token: undefined, data: env.PLAYGROUND_DATA });

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;
export { SampleDataDO } from "../src/sample-data";

export default { fetch: playground.fetch, queue: karmi.queueHandler };
