---
"@karmi/core": patch
---

`karmi doctor` has a new `--env <name>` option. It checks the configuration as wrangler resolves it for that environment. An `env` section inherits `main`, `account_id`, `compatibility_date`, `compatibility_flags` and `migrations` from the top level, and it does not inherit bindings. An unknown environment name is an error that names the known environments. `decodeWranglerConfig(source, env)` does the same for a test.

Without `--env`, a configuration that has `env` sections now gets one `warn` finding from the new `environments` check. The finding names each environment that doctor did not check. Before this change, doctor ignored the `env` sections and gave a pass.

A bound Durable Object class that doctor does not find in the Worker entry now gets a `skip` finding when the entry has an `export * from` line. Before this change, the class got a `fail` finding, and the command exited with code 1. The finding stays a `fail` when the entry has no such line.
