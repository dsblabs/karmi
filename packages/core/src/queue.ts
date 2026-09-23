import type { KarmiBindings } from "./bindings";
import type { DeliveryBinding } from "./deliverer";
import type { Deployment } from "./deployment";
import { KarmiError, errorMessage } from "./errors";
import { keys } from "./keys";
import { remote, unwrap } from "./outcome";
import { openScope } from "./scope";
import type { ThreadDurableObject } from "./thread-do";
import { decodeKey } from "./thread";
import type { UsageRecord } from "./usage";

/**
 * One message on `KARMI_QUEUE`: a range of one Thread's events for its Deliverer, or a batch of Usage
 * records for the UsageHandler.
 */
export type QueueMessage =
  | {
      kind: "delivery";
      scope: string;
      threadKey: string;
      fromSeq: number;
      toSeq: number;
      /**
       * The route captured when the range was added. Without it, the consumer reads the route from the
       * Thread Outbox.
       */
      binding?: DeliveryBinding;
    }
  | { kind: "usage"; records: UsageRecord[] };

// The Thread Durable Object is the only producer, so the body is trusted once its `kind` is known.
function decodeQueueMessage(body: unknown): QueueMessage {
  if (typeof body === "object" && body !== null && "kind" in body) {
    if (body.kind === "usage") return body as QueueMessage;
    if (body.kind === "delivery") {
      const message = body as Extract<QueueMessage, { kind: "delivery" }>;
      if (!("binding" in body) || body.binding === undefined) return message;
      return { ...message, binding: decodeQueueBinding(body.binding) };
    }
    throw new KarmiError("queue.unhandled", `Unknown Queue job "${String(body.kind)}".`);
  }
  throw new KarmiError("queue.unhandled", "A Queue message without a kind.");
}

function decodeQueueBinding(value: unknown): DeliveryBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("ref" in value)
  )
    throw new KarmiError("deliverer.invalid", "A delivery route requires { name, ref }.");
  return { name: value.name, ref: value.ref };
}

/**
 * Builds the Queue consumer. A `delivery` message names a Thread and a `seq` range, which the handler reads
 * from the Thread and hands to the bound Deliverer, skipping Threads of a destroying or destroyed Scope. A
 * `usage` message carries Usage records for the Catalogue's UsageHandler, and is acknowledged unread when the
 * Catalogue has none. Any failure retries the message.
 */
export function queueHandler(deployment: Deployment, bindings: KarmiBindings): ExportedHandlerQueueHandler {
  return async (batch) => {
    for (const message of batch.messages) {
      try {
        const body = decodeQueueMessage(message.body);
        if (body.kind === "usage") await deployment.catalogue.usageHandler?.onUsage(body.records);
        else await deliver(deployment, bindings, body);
        message.ack();
      } catch (error) {
        deployment.logger.warn("Queue message failed and will retry", { error: errorMessage(error) });
        // Cloudflare applies the configured retry limit and moves exhausted messages to the DLQ.
        message.retry();
      }
    }
  };
}

async function deliver(
  deployment: Deployment,
  bindings: KarmiBindings,
  body: Extract<QueueMessage, { kind: "delivery" }>,
): Promise<void> {
  const scope = openScope(deployment, bindings, body.scope);
  const status = await scope.status();
  if (status.state === "destroying" || status.state === "destroyed") return;
  const identity = decodeKey(body.threadKey);
  const stub = remote<ThreadDurableObject>(bindings.KARMI_THREADS, keys.thread(body.scope, identity.threadId));
  const delivery = await unwrap(
    stub.delivery({ ...identity, scope: body.scope, create: false }, body.fromSeq, body.toSeq, body.binding),
  );
  if (!delivery) return;
  const deliverer = deployment.catalogue.deliverers.get(delivery.binding.name);
  if (!deliverer) throw new KarmiError("deliverer.notFound", `Unknown Deliverer "${delivery.binding.name}".`);
  await deliverer.deliver(body.threadKey, delivery.events, delivery.binding.ref);
}
