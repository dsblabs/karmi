---
"@karmi/core": patch
---

Fix offline delivery for a Schedule that fires. The `channelRef.deliverer` of its Event did not become the Deliverer of the Thread, so the Deliverer got the output only when an earlier `send` had set it. `thread.schedule()` now rejects an Event that names an unknown Deliverer with `deliverer.notFound`, as `send` does. It rejects an Event that names a Deliverer with `bindings.missing` when the Worker has no `KARMI_QUEUE` binding.
