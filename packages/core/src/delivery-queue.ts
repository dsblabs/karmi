import type { KarmiBindings } from "./bindings";
import type { Catalogue } from "./catalogue";
import { KarmiError } from "./errors";
import { keys } from "./keys";
import { remote, unwrap } from "./outcome";
import { openScope } from "./scope";
import type { ThreadDurableObject } from "./thread-do";
import { decodeKey } from "./thread";

export function deliveryQueueHandler(bindings: KarmiBindings, catalogue: Catalogue): ExportedHandlerQueueHandler {
  return async (batch) => {
    for (const message of batch.messages) {
      try {
        const body = message.body as { kind: string; scope: string; threadKey: string; fromSeq: number; toSeq: number };
        if (body.kind !== "delivery") throw new KarmiError("queue.unhandled", `Unknown Queue job "${body.kind}".`);
        const scope = openScope(bindings, body.scope);
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
