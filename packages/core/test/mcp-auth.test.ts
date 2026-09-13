import { describe, expect, it } from "vitest";
import {
  clientDocument,
  decodeOAuthState,
  encodeOAuthState,
  mcpHolder,
  mcpPartition,
  needsPreRegistration,
  preRegistration,
  preRegistrationMessage,
  tokenExpiry,
  tokenFresh,
} from "../src/mcp-auth";

const identity = { origin: "https://agents.example.com", clientName: "Acme Agents" };

describe("holders and partitions", () => {
  it("derives the holder from the level, and none for a user-level server without a User", () => {
    expect(mcpHolder("agent", "concierge", "alice")).toBe("agent:concierge");
    expect(mcpHolder("user", "concierge", "alice")).toBe("user:alice");
    expect(mcpHolder("user", "concierge", undefined)).toBeUndefined();
  });

  it("partitions catalogues by holder only under OAuth", () => {
    expect(mcpPartition({ type: "oauth", level: "user" }, "user:alice")).toBe("user:alice");
    expect(mcpPartition({ type: "oauth", level: "user" }, undefined)).toBe("scope");
    expect(mcpPartition({ type: "static", headers: {} }, "user:alice")).toBe("scope");
    expect(mcpPartition(undefined, undefined)).toBe("scope");
  });
});

describe("state and tokens", () => {
  it("round-trips the Scope and nonce through the state parameter", () => {
    expect(decodeOAuthState(encodeOAuthState("tenant-1", "abc"))).toEqual({ scope: "tenant-1", nonce: "abc" });
    expect(decodeOAuthState("no-dot")).toBeUndefined();
    expect(decodeOAuthState("a.b.c")).toBeUndefined();
  });

  it("treats a token as stale shortly before it expires, and one without expiry as fresh", () => {
    expect(tokenExpiry(3600, 1_000)).toBe(3_601_000);
    expect(tokenExpiry(undefined, 1_000)).toBeUndefined();
    expect(tokenFresh(undefined, 5)).toBe(true);
    expect(tokenFresh(100_000, 50_000)).toBe(true);
    expect(tokenFresh(100_000, 80_000)).toBe(false);
  });
});

describe("client identity", () => {
  it("publishes a CIMD document whose client_id is its own URL, with one exact redirect and no secret", () => {
    expect(clientDocument(identity)).toEqual({
      client_id: "https://agents.example.com/.well-known/karmi-mcp-client.json",
      client_name: "Acme Agents",
      client_uri: "https://agents.example.com",
      redirect_uris: ["https://agents.example.com/mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(clientDocument({ origin: "https://x.example" }).client_name).toBe("x.example");
  });

  it("knows the issuers that take only a pre-registered client and renders their checklist", () => {
    expect(preRegistration("https://github.com/login/oauth/")?.name).toBe("GitHub");
    expect(preRegistration("https://mcp.notion.com")).toBeUndefined();
    expect(needsPreRegistration({})).toBe(true);
    expect(needsPreRegistration({ client_id_metadata_document_supported: true })).toBe(false);
    expect(needsPreRegistration({ registration_endpoint: "https://as/register" })).toBe(false);
    const message = preRegistrationMessage("gh", "https://github.com/login/oauth", identity);
    expect(message).toContain("https://github.com/settings/developers");
    expect(message).toContain("a client secret is required");
    expect(message).toContain("https://agents.example.com/mcp/oauth/callback");
    expect(preRegistrationMessage("x", "https://as.example", identity)).toContain("Register a client with");
  });
});
