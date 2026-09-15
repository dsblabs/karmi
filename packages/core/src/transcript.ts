import { providerReplayKey } from "./replay";
import { filePlaceholder } from "./media-request";
import { summaryMessages } from "./compaction";
import type { ContentBlock, Message } from "./provider";
import type { ThreadEvent, TurnInput } from "./thread-events";

// The transcript is derived from the event log and never stored. Every Turn input becomes a user
// message, every completed model Step an assistant message, and every completed tool Step its results
// in the order the model asked for them. Blocks of a Step whose attempt never completed (a failed
// fallback, an evicted run, the Step in flight) are not part of the conversation. A `thread.compacted`
// event stands for everything before its `firstKeptSeq`. The caller passes the log from that seq on,
// and the summary opens the transcript wherever the event sits in it.

/** The model-facing transcript of a Thread, built from its event log from the last Compaction on. */
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
          step = {
            provider: providerReplayKey(event.provider, event.model),
            model: splitModelId(event.model)[1],
            content: [],
          };
        break;
      case "message.part":
        step?.content.push(event.block);
        break;
      case "tool.result":
        if (event.parentCallId) break;
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

/** A user message holding `text`. A Skill activated by a User command enters the transcript this way. */
const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

/**
 * The content blocks a Turn input contributes to its user message. An Event renders as text, and a
 * file Part that is not a PDF becomes a text placeholder.
 */
export function inputContent(input: TurnInput): ContentBlock[] {
  if (input.kind === "event") return [{ type: "text", text: renderEvent(input) }];
  return input.parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : part.type === "file" && part.media.mimeType !== "application/pdf"
        ? filePlaceholder(part.media)
        : { type: "media", media: part.media },
  );
}

/** The text an Event is shown to the Agent as: its type followed by its JSON payload. */
export function renderEvent(input: Extract<TurnInput, { kind: "event" }>): string {
  return `Event ${JSON.stringify(input.type)}:\n${JSON.stringify(input.payload)}`;
}

/**
 * Splits a `provider/model` id as an Agent Spec writes it into the Provider profile name and the
 * provider-native model id.
 */
export function splitModelId(id: string): [provider: string, model: string] {
  const slash = id.indexOf("/");
  return [id.slice(0, slash), id.slice(slash + 1)];
}
