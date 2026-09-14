import type { KarmiBindings } from "./bindings";
import type { Deployment } from "./deployment";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { remote, unwrap } from "./outcome";
import { openScope } from "./scope";
import type { ThreadDurableObject } from "./thread-do";
import { decodeKey } from "./thread";

/**
 * Builds the Queue consumer that runs Deliverers. Each message names a Thread and a `seq` range. The handler
 * reads those events from the Thread and hands them to the bound Deliverer, retrying the message on any failure.
 * Threads of a destroying or destroyed Scope are skipped and the message is acknowledged.
 */
export function deliveryQueueHandler(deployment: Deployment, bindings: KarmiBindings): ExportedHandlerQueueHandler {
  const { catalogue } = deployment;
  return async (batch) => {
    for (const message of batch.messages) {
      try {
        const body = message.body as { kind: string; scope: string; threadKey: string; fromSeq: number; toSeq: number };
        if (body.kind !== "delivery") throw new KarmiError("queue.unhandled", `Unknown Queue job "${body.kind}".`);
        const scope = openScope(deployment, bindings, body.scope);
        const status = await scope.status();
        if (status.state !== "destroying" && status.state !== "destroyed") {
          const identity = decodeKey(body.threadKey);
          const stub = remote<ThreadDurableObject>(bindings.KARMI_THREADS, keys.thread(body.scope, identity.threadId));
          const delivery = await unwrap(
            stub.delivery({ ...identity, scope: body.scope, create: false }, body.fromSeq, body.toSeq),
          );
          if (delivery) {
            const deliverer = catalogue.deliverers.get(delivery.binding.name);
            if (!deliverer) throw new KarmiError("deliverer.notFound", `Unknown Deliverer "${delivery.binding.name}".`);
            await deliverer.deliver(body.threadKey, delivery.events, delivery.binding.ref);
          }
        }
        message.ack();
      } catch {
        // Cloudflare applies the configured retry limit and moves exhausted messages to the DLQ.
        message.retry();
      }
    }
  };
}
