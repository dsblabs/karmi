---
"@karmi/core": patch
---

Fix `thread.fork()` for a Thread event log that is long. The Fork failed with the SQLite error `too many SQL variables` when the log had more than 20 events.
