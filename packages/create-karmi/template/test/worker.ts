import { createTestKarmi } from "@karmi/core/testing";
import { catalogue } from "../src/catalogue";

// The test Worker runs the same Catalogue as src/worker.ts against a scripted Provider, so no test needs
// an API key or a network.
export const { karmi, provider, scope, clock } = createTestKarmi(catalogue);

export const { ThreadDO, ScopeConfigDO, MemoryDO, KnowledgeDO } = karmi.durableObjects;

export default { queue: karmi.queueHandler };
