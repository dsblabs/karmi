import type { ContentBlock, Message } from "./provider.js";
import type { ThreadEvent, TurnInput } from "./thread-events.js";

// The transcript is derived from the event log, never stored: every Turn input is a user message,
// every completed model Step an assistant message, every completed tool Step its results in the
// order the model asked for them. Blocks of a Step whose attempt never completed (a failed fallback,
// an evicted run, the Step in flight) are not part of the conversation.

export function transcriptFromEvents(events: readonly ThreadEvent[]): Message[] {
  const messages: Message[] = [];
  let step: { provider: string; model: string; content: ContentBlock[] } | undefined;
  let calls: { id: string; name: string }[] = [];
  const results = new Map<string, Extract<ThreadEvent, { type: "tool.result" }>>();
  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        messages.push({ role: "user", content: inputContent(event.input) });
        break;
      case "step.started":
        if (event.kind === "model") step = { provider: event.provider, model: splitModelId(event.model)[1], content: [] };
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
            messages.push({ role: "assistant", content: step.content, provider: step.provider, model: step.model, stopReason: event.stopReason });
            calls = step.content.flatMap((block) => (block.type === "tool_call" ? [{ id: block.id, name: block.name }] : []));
            results.clear();
          }
          step = undefined;
        } else {
          for (const call of calls) {
            const result = results.get(call.id);
            if (result) messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError });
          }
        }
        break;
    }
  }
  return messages;
}

export function inputContent(input: TurnInput): ContentBlock[] {
  if (input.kind === "event") return [{ type: "text", text: renderEvent(input) }];
  return input.parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "media", media: part.media }));
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
