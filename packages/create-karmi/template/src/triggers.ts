import type { Karmi } from "@karmi/core";

// External triggers are your own code over the Thread API. karmi keeps no list of Scopes, so a cron or a
// Queue consumer names the Scopes it drives.

/** A message on your own Queue: which Thread to drive and what to say to it. */
export interface InboxMessage {
  scope: string;
  agent: string;
  threadId: string;
  text: string;
  user?: string;
}

/** Reads one Queue message body. Throws when it is not an `InboxMessage`, so the message retries. */
export function decodeInboxMessage(body: unknown): InboxMessage {
  const value: Partial<InboxMessage> = typeof body === "object" && body !== null ? body : {};
  const { scope, agent, threadId, text, user } = value;
  if (!scope || !agent || !threadId || !text) throw new Error("A Queue message is not an InboxMessage.");
  if (user !== undefined && typeof user !== "string") throw new Error("A Queue message has a non-string user.");
  return { scope, agent, threadId, text, ...(user !== undefined && { user }) };
}

const say = (text: string) => ({ kind: "message" as const, parts: [{ type: "text" as const, text }] });

/**
 * Starts one briefing Turn per Scope. The Thread id is the day, so a re-run of the same day's cron adds a
 * Turn to the same Thread instead of starting another one.
 */
export async function dailyBriefing(karmi: Karmi, scopes: readonly string[], day: string): Promise<void> {
  for (const id of scopes) {
    const thread = karmi.scope(id).thread({ agent: "concierge", threadId: `briefing-${day}` });
    await thread.send(say("Summarise today's arrivals."));
  }
}

/**
 * Drives one Thread per Queue message. A message whose Turn could not be started is retried rather than
 * acknowledged, so nothing is lost when a Scope is briefly unavailable.
 */
export async function handleInbox(karmi: Karmi, batch: MessageBatch<unknown>): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { scope, agent, threadId, text, user } = decodeInboxMessage(message.body);
      const thread = karmi.scope(scope).thread({ agent, threadId, ...(user !== undefined && { user }) });
      await thread.send(say(text));
      message.ack();
    } catch {
      message.retry();
    }
  }
}
