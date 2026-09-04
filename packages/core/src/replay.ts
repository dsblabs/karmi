import type { ContentBlock, Message } from "./provider.js";

// Cross-provider replay rules, ported from pi-ai's transformMessages and run by the Harness before any
// adapter sees the transcript. Every rule is keyed on the provider/model each assistant message records.

export interface ReplayTarget {
  provider: string;
  model: string;
}

export interface ReplayResult {
  /** Leading system messages, joined; the caller appends them to the Prompt. */
  system?: string;
  messages: Message[];
}

// What Anthropic accepts as a tool-call id; the strictest of the providers, so it is the common form.
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORPHAN_RESULT: ContentBlock[] = [{ type: "text", text: "No result provided" }];

/**
 * Prepares a persisted transcript for one model call: drops failed assistant turns, keeps
 * provider-opaque blocks (thinking signatures, server-tool results, compaction, `provider`) only for
 * the model or provider that produced them, normalises tool-call ids, repairs orphaned tool calls,
 * and places system messages where every provider accepts them.
 */
export function prepareMessages(messages: Message[], target: ReplayTarget): ReplayResult {
  const idMap = new Map<string, string>();
  const out: Message[] = [];
  const leadingSystem: string[] = [];

  // Tool calls awaiting a result, in order, and the system text that must wait until the batch is answered.
  let pending: { id: string; name: string }[] = [];
  let answered = new Set<string>();
  let deferredSystem: string[] = [];

  const closeBatch = (): void => {
    for (const call of pending) {
      if (!answered.has(call.id)) out.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: ORPHAN_RESULT, isError: true });
    }
    pending = [];
    answered = new Set();
    if (deferredSystem.length > 0) {
      out.push({ role: "system", content: deferredSystem.join("\n\n") });
      deferredSystem = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "system": {
        if (out.length === 0) leadingSystem.push(message.content);
        else if (pending.length > 0) deferredSystem.push(message.content);
        else {
          const last = out[out.length - 1];
          if (last?.role === "system") out[out.length - 1] = { role: "system", content: `${last.content}\n\n${message.content}` };
          else out.push(message);
        }
        break;
      }
      case "user": {
        closeBatch();
        out.push(message);
        break;
      }
      case "toolResult": {
        const id = idMap.get(message.toolCallId) ?? message.toolCallId;
        // A result whose call was dropped with a failed assistant turn has nothing to answer.
        if (!pending.some((call) => call.id === id)) break;
        answered.add(id);
        out.push(id === message.toolCallId ? message : { ...message, toolCallId: id });
        break;
      }
      case "assistant": {
        closeBatch();
        if (message.stopReason === "error" || message.stopReason === "aborted") break;
        const sameModel = message.provider === target.provider && message.model === target.model;
        const sameProvider = message.provider === target.provider;
        const content = message.content.flatMap((block) => replayBlock(block, sameModel, sameProvider, idMap));
        for (const block of content) if (block.type === "tool_call") pending.push({ id: block.id, name: block.name });
        out.push({ ...message, content });
        break;
      }
    }
  }
  closeBatch();

  const result: ReplayResult = { messages: out };
  if (leadingSystem.length > 0) result.system = leadingSystem.join("\n\n");
  return result;
}

function replayBlock(block: ContentBlock, sameModel: boolean, sameProvider: boolean, idMap: Map<string, string>): ContentBlock[] {
  switch (block.type) {
    case "thinking": {
      if (sameModel) return block.redacted || block.signature || block.text.trim() ? [block] : [];
      return block.redacted || !block.text.trim() ? [] : [{ type: "text", text: block.text }];
    }
    case "tool_call": {
      const id = normalizeToolCallId(block.id);
      if (id !== block.id) idMap.set(block.id, id);
      if (id === block.id && (sameModel || !block.signature)) return [block];
      const { signature, ...rest } = block;
      return [sameModel && signature ? { ...rest, id, signature } : { ...rest, id }];
    }
    case "server_tool":
      return sameProvider ? [block] : block.result ? [{ type: "text", text: block.result.summary }] : [];
    case "compaction":
      return sameProvider && block.raw ? [block] : [{ type: "text", text: block.summary }];
    case "provider":
      return sameProvider ? [block] : [];
    default:
      return [block];
  }
}

/** Ids from other providers can be hundreds of characters with `|` and the like; keep them unique and portable. */
export function normalizeToolCallId(id: string): string {
  if (TOOL_CALL_ID.test(id)) return id;
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_") || "call";
  return safe.length <= 64 ? safe : `${safe.slice(0, 55)}_${fnv1a(id)}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
