import { fakeMcpServer, type FakeMcpTool } from "@karmi/core/testing";
import { z } from "zod";

/** A read-only Tool that each fake server has. The scripted Agent calls it. */
const readNotice = (text: string): FakeMcpTool => ({
  name: "read_notice",
  description: "Read the notice board of the sample shop",
  annotations: { readOnlyHint: true },
  execute: () => text,
});

/** A Tool that changes data. Its annotations say so, thus the Policy never allows it without an Approval. */
const postNotice: FakeMcpTool = {
  name: "post_notice",
  description: "Post a notice on the board of the sample shop",
  input: z.object({ text: z.string() }),
  annotations: { destructiveHint: true },
  execute: ({ text }: { text: string }) => `Posted: ${text}`,
};

/** A server with no credential. */
export const board = fakeMcpServer({ name: "board", tools: [readNotice("The shop opens at 9."), postNotice] });

/** The header value that the server with a static credential accepts. */
export const KEYED_SECRET = "Bearer keyed-secret-4711";

/** A server that needs a static header. A request without it gets a 401 answer. */
export const keyed = fakeMcpServer({
  name: "keyed",
  tools: [readNotice("The keyed board says hello.")],
  auth: { header: "Authorization", value: KEYED_SECRET },
});

/**
 * A server behind OAuth that speaks the 2026 protocol. Its tool list is `public`, thus a Turn without a grant still
 * offers its Tools, and a call asks for the Connection.
 */
export const vault = fakeMcpServer({ name: "vault", tools: [readNotice("The vault holds 3 files.")], oauth: {} });

/** A server behind OAuth that speaks the 2025 protocol. Its tool list is `private` to the User of the grant. */
export const drive = fakeMcpServer({
  name: "drive",
  era: "2025-06-18",
  tools: [readNotice("The drive holds 2 files.")],
  oauth: {},
});

/** Each fake server. The Scoped fetch of the test Workers routes a request to the fake with the same host. */
export const MCP_SERVERS = [board, keyed, vault, drive];
