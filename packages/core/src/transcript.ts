import { summaryMessages } from "./compaction";
import type { ContentBlock, Message } from "./provider";
import type { ThreadEvent, TurnInput } from "./thread-events";

// The transcript is derived from the event log, never stored: every Turn input is a user message,
// every completed model Step an assistant message, every completed tool Step its results in the
// order the model asked for them. Blocks of a Step whose attempt never completed (a failed fallback,
// an evicted run, the Step in flight) are not part of the conversation. A `thread.compacted` stands
// for everything before its `firstKeptSeq`: the caller passes the log from that seq on, and the
// summary opens the transcript wherever the event sits in it.

export function transcriptFromEvents(events: readonly ThreadEvent[]): Message[] {
  const messages: Message[] = [];
  let step: { provider: string; model: string; content: ContentBlock[] } | undefined;
  let calls: { id: string; name: string }[] = [];
  const results = new Map<string, Extract<ThreadEvent, { type: "tool.result" }>>();
  for (const event of events) {
    switch (event.type) {
      case "thread.compacted":
        messages.unshift(...summaryMessages(event));
        break;
      case "turn.started":
      case "turn.input":
        messages.push({ role: "user", content: inputContent(event.input) });
        break;
      case "tools.loaded":
        if (event.skill?.body !== undefined) messages.push(userText(event.skill.body));
        break;
      case "step.started":
        if (event.kind === "model")
          step = { provider: event.provider, model: splitModelId(event.model)[1], content: [] };
        break;
      case "message.part":
        step?.content.push(event.block);
        break;
      case "tool.result":
        results.set(event.id, event);
        break;
      case "step.completed":
        if (event.kind === "model") {
          if (step) {
            messages.push({
              role: "assistant",
              content: step.content,
              provider: step.provider,
              model: step.model,
              stopReason: event.stopReason,
            });
            calls = step.content.flatMap((block) =>
              block.type === "tool_call" ? [{ id: block.id, name: block.name }] : [],
            );
            results.clear();
          }
          step = undefined;
        } else {
          for (const call of calls) {
            const result = results.get(call.id);
            if (result) messages.push(toolResultMessage(call, result));
          }
        }
        break;
    }
  }
  return messages;
}

const toolResultMessage = (
  call: { id: string; name: string },
  result: Extract<ThreadEvent, { type: "tool.result" }>,
): Message => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: result.content,
  isError: result.isError,
});

/** A Skill a User command activated reads as a user message; `use_skill` returns the same text as its result instead. */
const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

export function inputContent(input: TurnInput): ContentBlock[] {
  if (input.kind === "event") return [{ type: "text", text: renderEvent(input) }];
  return input.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : { type: "media", media: part.media },
  );
}

/** The Event Fragment: how a non-chat Turn input is shown to the Agent. */
export function renderEvent(input: Extract<TurnInput, { kind: "event" }>): string {
  return `Event ${JSON.stringify(input.type)}:\n${JSON.stringify(input.payload)}`;
}

/** `provider/model` as an Agent Spec writes it, into the profile prefix and the provider-native id. */
export function splitModelId(id: string): [provider: string, model: string] {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
}
