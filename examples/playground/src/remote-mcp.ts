import { defineAgent, type AgentSpec, type McpServerConfig, type ScopeConfigDocument } from "@karmi/core";
import { z } from "zod";
import { decodeSample } from "./sample-data";

/** The id of the remote MCP and OAuth Connections scenario. */
export const MCP = "mcp";
/** The id of the Agent of the scenario. */
export const MCP_DESK = "mcp-desk";
/** The id of the registered server. The model sees each of its Tools as `remote__<tool>`. */
export const SERVER = "remote";
/** The name of the Scope credential that holds the static header value of the server. */
export const STATIC_CREDENTIAL = "mcp-remote";
/** The reference to the static credential that the Scope config names. */
export const STATIC_REFERENCE = `scope:${STATIC_CREDENTIAL}`;
/** The name of the OAuth grant of the server as a Connection of the User. */
export const CONNECTION = `mcp:${SERVER}`;
/** The name that the consent screen of an authorization server shows for the Playground. */
export const CLIENT_NAME = "karmi Playground";

/** The prompts that the scenario suggests. The operator can edit each one. */
export const MCP_PROMPTS = [
  {
    label: "Use a Tool",
    text: "Use one Tool of the remote server that reads data. Tell me in two sentences what it returned.",
  },
  { label: "List the Tools", text: "Which Tools of the remote server can you use? Give one line for each Tool." },
];

/**
 * The id of the disposable Scope for one generation of the scenario. A reset destroys the Scope with its
 * registration, credential, Connections and cached tool lists, and moves to the next generation and a new id.
 */
export const mcpScope = (generation: number): string => `sample-mcp-${String(generation)}`;

/**
 * Defines the Agent for the model that setup selected. It has no Tool until the operator registers a server. Its
 * Policy allows a read-only Tool, thus each other call waits for an Approval.
 */
export const mcpDeskAgent = (model: string) =>
  defineAgent({
    agentId: MCP_DESK,
    name: "Remote tools desk",
    instructions: [
      {
        text: "You are the remote tools desk of the karmi Playground. Use the Tools of the remote MCP server to answer. When you have no Tool of the server, tell the operator to register a server in the Remote MCP server card. When a Tool call fails, tell the operator the error in one sentence. Answer in two sentences or less.",
      },
    ],
    model: { id: model },
    policy: [{ match: { annotations: { readOnlyHint: true } }, effect: "allow" }],
  });

/**
 * The Agent Spec that the registration stores in the disposable Scope. It is the Catalogue Agent with each Tool of the
 * registered server. The Scope validates the reference, thus the server must be in the Scope config first. Without
 * trustAnnotations, no Tool of the server is read-only.
 */
export const mcpDeskSpec = (model: string): AgentSpec => ({ ...mcpDeskAgent(model).spec, tools: [`mcp:${SERVER}`] });

/** The longest header value that the route accepts. A token is much shorter. */
const MAX_VALUE = 4096;

const registrationSchema = z.discriminatedUnion("auth", [
  z.object({ auth: z.literal("none"), url: z.url(), trustAnnotations: z.boolean().default(false) }),
  z.object({ auth: z.literal("oauth"), url: z.url(), trustAnnotations: z.boolean().default(false) }),
  z.object({
    auth: z.literal("static"),
    url: z.url(),
    trustAnnotations: z.boolean().default(false),
    // A header name is a token of RFC 9110.
    header: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/),
    /** The header value. The route stores it as a Scope credential and never returns it. */
    // The route stores the value as typed. A value of spaces only is not a credential.
    value: z.string().max(MAX_VALUE).regex(/\S/),
  }),
]);

/**
 * The server that the operator registers from the page: with no credential, with one static header or with a
 * user-level OAuth grant.
 */
export type Registration = z.infer<typeof registrationSchema>;

/**
 * Decodes the body of the registration route. Returns undefined when the body is not a registration. The Scope
 * config checks the rest of the URL: it refuses a private address, and http on a host other than loopback.
 */
export function decodeRegistration(body: unknown): Registration | undefined {
  const parsed = registrationSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Scope config of a registration. It permits MCP requests to the host of the server only. A static header names
 * the Scope credential, never the value.
 */
export function mcpConfig(registration: Registration): ScopeConfigDocument {
  const { url, trustAnnotations } = registration;
  const server: McpServerConfig = {
    url,
    trustAnnotations,
    auth:
      registration.auth === "static"
        ? { type: "static", headers: { [registration.header]: STATIC_REFERENCE } }
        : registration.auth === "oauth"
          ? { type: "oauth", level: "user" }
          : { type: "none" },
  };
  return { mcp: { servers: { [SERVER]: server } }, egress: { mcpHosts: [new URL(url).hostname] } };
}

/** Whether the Worker can take part in OAuth: its public origin, or why it cannot. */
export type OAuthSetup = { origin: string } | { reason: string };

/**
 * Reads the `PLAYGROUND_ORIGIN` variable. OAuth needs an https origin: the MCP client refuses a client document at
 * an http URL, and the authorization server must reach the document and send the browser back to the callback.
 */
export function oauthSetup(value: string | undefined): OAuthSetup {
  if (!value)
    return {
      reason:
        "OAuth needs PLAYGROUND_ORIGIN, the public https origin of the Playground. pnpm deploy sets it. For local development, add it to .dev.vars.",
    };
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "https:") return { reason: `OAuth needs an https origin. PLAYGROUND_ORIGIN is ${value}.` };
  return { origin: url.origin };
}

/** The result of the last tool list refresh from the page: a success, or the code and the message of the error. */
const discoverySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), at: z.number() }),
  z.object({ ok: z.literal(false), at: z.number(), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** The stored sample data of the scenario. */
const mcpDataSchema = z.object({ discovery: z.optional(discoverySchema) });

/** The sample data of the scenario. */
export type McpData = z.infer<typeof mcpDataSchema>;

/** Decodes the stored sample data. Data that is absent or not valid gives no discovery result. */
export const decodeMcpData = (data: string | undefined): McpData => decodeSample(mcpDataSchema, {}, data);
