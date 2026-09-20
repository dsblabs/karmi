import { providerOption, type ProviderSetup } from "../src/provider-options";

/** The access token of the test Workers. */
export const TOKEN = "test-token";

const option = providerOption("openrouter");
if (!option) throw new Error("The openrouter option is missing.");
/** The setup that the test Workers report. Its Provider cannot promise Tool calls, so a model note appears. */
export const setup: ProviderSetup = { option, model: "test/model" };
