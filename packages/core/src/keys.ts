import { sha256Hex } from "./digest";
import type { ScopeId } from "./context";
import { KarmiError } from "./errors";
import { assertIdentifier, KNOWLEDGE_NAME, KNOWLEDGE_NAME_MESSAGE } from "./names";

/**
 * The functions that mint every storage name (ADR-0001). Every Durable Object name is
 * `{scope}/{kind}/{id}` and every R2 key starts with `{scope}/`. A child Thread id encodes the stable
 * Tool callId of its parent call into one path segment.
 */
export const keys = {
  /** The per-Thread container Workspace identity. */
  workspace: (scope: string, threadId: string) => `${scope}/${threadId}`,
  toolCall(threadId: string, seq: number): string {
    return `${threadId}:${seq}`;
  },
  toolCallSeq(threadId: string, callId: string): number | undefined {
    const prefix = `${threadId}:`;
    const seq = callId.startsWith(prefix) ? Number(callId.slice(prefix.length)) : NaN;
    return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
  },
  scriptCall(parentCallId: string, ordinal: number): string {
    return `${parentCallId}/script/${ordinal}`;
  },
  structuredToolOutput(scope: ScopeId, threadId: string, seq: number): string {
    return `${keys.toolOutput(scope, threadId, seq)}.json`;
  },
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
  knowledge(scope: ScopeId, name: string): string {
    if (!KNOWLEDGE_NAME.test(name)) throw new KarmiError("knowledge.invalid", KNOWLEDGE_NAME_MESSAGE);
    return `${assertScope(scope)}/knowledge/${name}`;
  },
  async vector(scope: ScopeId, knowledge: string, doc: string, seq: number): Promise<string> {
    return (await sha256Hex(JSON.stringify([assertScope(scope), knowledge, doc, seq]))).slice(0, 32);
  },
  async vectorMirror(scope: ScopeId, id: string): Promise<string> {
    return (await sha256Hex(JSON.stringify([assertScope(scope), id]))).slice(0, 32);
  },
  memory(scope: ScopeId, user: string): string {
    assertIdentifier("user.id.invalid", "user", user);
    return `${assertScope(scope)}/memory/${user}`;
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

/** The Scope of an R2 `key`, or undefined unless the key is a Framework media or spilled-output key. */
export function mediaKeyScope(key: string): string | undefined {
  return parseObjectKey(key)?.scope;
}

/** A Framework media or spilled-output R2 key split into the parts it was minted from. */
export type ObjectKey =
  | {
      kind: "media";
      scope: ScopeId;
      /** The Thread whose media prefix holds the object. */
      threadId: string;
      /** The media id, which is also the last segment of the key. */
      id: string;
    }
  | {
      kind: "tool-output";
      scope: ScopeId;
      /** The Thread whose tool-output prefix holds the object. */
      threadId: string;
      /** The `seq` of the Tool result whose output was spilled. */
      seq: number;
      /** Whether the object holds the result's structured content as JSON rather than its text. */
      structured: boolean;
    };

const THREAD_ID = "[A-Za-z0-9_-]{1,64}(?:/[A-Za-z0-9_%-]+)*";
const WHOLE_THREAD_ID = new RegExp(`^${THREAD_ID}$`);
const OBJECT_KEY = new RegExp(
  `^([A-Za-z0-9_-]{1,64})/(?:media/(${THREAD_ID})/([A-Za-z0-9_-]{1,64})|threads/(${THREAD_ID})/tool-output/(\\d+)(\\.json)?)$`,
);

/** The parts of an R2 `key`, or undefined unless the key is a Framework media or spilled-output key. */
export function parseObjectKey(key: string): ObjectKey | undefined {
  const [, scope, mediaThread, id, outputThread, seq, json] = OBJECT_KEY.exec(key) ?? [];
  if (!scope) return undefined;
  if (mediaThread && id) return { kind: "media", scope, threadId: mediaThread, id };
  if (outputThread && seq)
    return { kind: "tool-output", scope, threadId: outputThread, seq: Number(seq), structured: !!json };
  return undefined;
}

/**
 * Whether Thread `threadId` of `scope` may read the object at `key`. A Thread reads its own objects and those
 * of the Threads above and below it in a chain of Delegations, because Delegation hands media from a parent to
 * its child and back. It never reads another Scope's objects or those of any other Thread.
 */
export function threadMayRead(key: string, scope: ScopeId, threadId: string): boolean {
  const owner = parseObjectKey(key);
  if (owner?.scope !== scope) return false;
  // A child Thread's id is its parent's id followed by one more path segment.
  return (
    owner.threadId === threadId ||
    owner.threadId.startsWith(`${threadId}/`) ||
    threadId.startsWith(`${owner.threadId}/`)
  );
}

function assertThreadId(id: string): void {
  if (id.length > 2048 || !WHOLE_THREAD_ID.test(id)) throw new KarmiError("thread.id.invalid", "Invalid Thread id.");
}
