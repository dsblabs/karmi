import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import { assertIdentifier } from "./names";

/**
 * The one place a storage name is minted (ADR-0001): every Durable Object name is `{scope}/{kind}/{id}`
 * and every R2 key starts with `{scope}/`. Ids are validated here so no segment can contain a slash.
 */
export const keys = {
  childThread(parent: string, callId: string): string {
    const segment = encodeURIComponent(callId).replace(
      /[.!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const id = `${parent}/${segment}`;
    assertThreadId(id);
    return id;
  },
  config(scope: ScopeId): string {
    return `${assertScope(scope)}/config`;
  },
  thread(scope: ScopeId, threadId: string): string {
    assertThreadId(threadId);
    return `${assertScope(scope)}/thread/${threadId}`;
  },
  r2Prefix(scope: ScopeId): string {
    return `${assertScope(scope)}/`;
  },
  threadObjects(scope: ScopeId, threadId: string): string[] {
    assertThreadId(threadId);
    return [`${assertScope(scope)}/media/${threadId}/`, `${assertScope(scope)}/threads/${threadId}/tool-output/`];
  },
  toolOutput(scope: ScopeId, threadId: string, seq: number): string {
    assertThreadId(threadId);
    return `${assertScope(scope)}/threads/${threadId}/tool-output/${seq}`;
  },
  media(scope: ScopeId, threadId: string, id: string): string {
    assertThreadId(threadId);
    assertIdentifier("media.id.invalid", "media id", id);
    return `${assertScope(scope)}/media/${threadId}/${id}`;
  },
};

function assertScope(scope: ScopeId): ScopeId {
  assertIdentifier("scope.id.invalid", "ScopeId", scope);
  return scope;
}

/** Accepts only Framework media/spill keys, including refs serialized before a restart. */
export function mediaKeyScope(key: string): string | undefined {
  return /^([A-Za-z0-9_-]{1,64})\/(?:media\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_%-]+)*\/[A-Za-z0-9_-]{1,64}|threads\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_%-]+)*\/tool-output\/\d+)$/.exec(
    key,
  )?.[1];
}

function assertThreadId(id: string): void {
  if (id.length > 2048 || !/^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_%-]+)*$/.test(id))
    throw new KarmiError("thread.id.invalid", "Invalid Thread id.");
}
