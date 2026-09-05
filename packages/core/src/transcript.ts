import type { ContentBlock, Message } from "./provider.js";
import type { ThreadEvent, TurnInput } from "./thread-events.js";

// The transcript is derived from the event log, never stored: every Turn input is a user message and
// every completed model Step an assistant message. Blocks of a Step whose attempt never completed
// (a failed fallback, an evicted run, the Step in flight) are not part of the conversation.

export function transcriptFromEvents(events: readonly ThreadEvent[]): Message[] {
  const messages: Message[] = [];
  let step: { provider: string; model: string; content: ContentBlock[] } | undefined;
  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        messages.push({ role: "user", content: inputContent(event.input) });
        break;
      case "step.started":
        step = { provider: event.provider, model: splitModelId(event.model)[1], content: [] };
        break;
      case "message.part":
        step?.content.push(event.block);
        break;
      case "step.completed":
        if (step) messages.push({ role: "assistant", content: step.content, provider: step.provider, model: step.model, stopReason: event.stopReason });
        step = undefined;
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
