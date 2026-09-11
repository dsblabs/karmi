import type { ScopeId } from "./context";
import { assertIdentifier } from "./names";

/**
 * The one place a storage name is minted (ADR-0001): every Durable Object name is `{scope}/{kind}/{id}`
 * and every R2 key starts with `{scope}/`. Ids are validated here so no segment can contain a slash.
 */
export const keys = {
  config(scope: ScopeId): string {
    return `${assertScope(scope)}/config`;
  },
  thread(scope: ScopeId, threadId: string): string {
    assertIdentifier("thread.id.invalid", "threadId", threadId);
    return `${assertScope(scope)}/thread/${threadId}`;
  },
  r2Prefix(scope: ScopeId): string {
    return `${assertScope(scope)}/`;
  },
  toolOutput(scope: ScopeId, threadId: string, seq: number): string {
    assertIdentifier("thread.id.invalid", "threadId", threadId);
    return `${assertScope(scope)}/threads/${threadId}/tool-output/${seq}`;
  },
  media(scope: ScopeId, threadId: string, id: string): string {
    assertIdentifier("thread.id.invalid", "threadId", threadId);
    assertIdentifier("media.id.invalid", "media id", id);
    return `${assertScope(scope)}/media/${threadId}/${id}`;
  },
};

function assertScope(scope: ScopeId): ScopeId {
  assertIdentifier("scope.id.invalid", "ScopeId", scope);
  return scope;
}
