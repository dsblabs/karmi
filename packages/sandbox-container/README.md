# @karmi/sandbox-container

The container image and trusted local runtime for karmi's shell and Python Scripts.
The image extends Cloudflare Sandbox SDK `0.12.9-python` with pandas, openpyxl,
pypdf, Pillow, Node, ffmpeg, and jq. Keep the SDK package and image versions aligned.

## Cloudflare deployment

Copy this package's Dockerfile into your Worker project. Export the container and
outbound proxy from the Worker entrypoint:

```ts
export { KarmiSandbox, ContainerProxy } from "@karmi/core";
const karmi = createKarmi({ catalogue, sandbox: { image: "./Dockerfile" } });
```

Add a `KARMI_SANDBOX` Durable Object binding to `KarmiSandbox`, a SQLite migration
for that class, and this Wrangler container configuration:

```json
{
  "containers": [{ "class_name": "KarmiSandbox", "image": "./Dockerfile", "max_instances": 10 }]
}
```

`sandbox.image` declares the image used by the deployment; Wrangler builds and
selects the actual image. `karmi doctor` reports the binding and configured image.
Do not bind secrets or add credentials to the image. Scripts receive no Tool bridge
and start with only PATH, HOME, and certificate-bundle paths in their environment.

Grant the capability in the Agent Spec:

```json
{
  "capabilities": {
    "scripts": {
      "tier": "container",
      "limits": { "wallMs": 1000, "jobMaxWallMs": 600000, "idleMs": 60000, "maxArtifacts": 20 },
      "egress": { "allow": ["example.com"] }
    }
  }
}
```

The model calls `run_script` with `code`, `language` (`shell` or `python`), and an
optional `files` object mapping plain filenames to MediaRefs in the current Scope.
Each call refreshes `/in` and `/out`; other Workspace files survive until Turn end,
idle expiry, cancellation, or Thread destruction. Files in `/out` become artifacts
under the Thread's media prefix, subject to Scope media limits. Symlinks are not
exported. Workspace names are `{scope}/{threadId}`, including Delegation children.

Defaults are 60 seconds before Job promotion, 10 minutes total process wall time,
60 seconds idle, and 20 artifacts. Scope Script ceilings cap these values.
`ceilings.scripts.maxContainers` limits simultaneous Workspaces across the Scope;
an omitted ceiling is unbounded. A reservation is released only after destruction,
so an unavailable container service can temporarily retain capacity.

An unfinished process is promoted in place. Its persisted process ID is polled by
the Thread alarm every five seconds. Stdout progress is emitted in chunks of at
most 4 KB. Process state, not an output stream closing, decides completion.
Cancellation signals SIGTERM, then SIGKILL if the process is still running, and
destroys the Workspace. A missing process fails with `container_lost`.

Egress defaults to an empty allowlist. HTTPS is intercepted Worker-side, and the
allowlist is applied on every Script, including an empty grant. Export the supplied
`ContainerProxy` to add denied hostname and grant-key diagnostics to stderr.

## Local execution

`LocalProcessSandbox` implements the same Sandbox interface and lifecycle using
host shell/Python processes and a temporary directory. Construct it with a
`ContainerHost` (process persistence, media input/output, progress, and clock) and
`ContainerLimits` from `@karmi/core/sandbox`. Its `run`, `poll`, and `cancel` methods
use the same inputs and results as the container adapter. After a promoted Job
finishes, persist its terminal event before calling `acknowledge()` to clear the
process record; until then, `poll()` returns the persisted completion.

This is for **trusted development scripts only**: host files remain accessible
and egress is not enforced. The `security` property exposes that label. Literal
`/in` and `/out` paths in code are translated into the temporary directory; paths
assembled dynamically are not translated. Host environment secrets are omitted.
Each process's retained stdout and stderr are limited to the last 1 MB locally.

`pnpm --filter @karmi/sandbox-container test` runs real shell/Python tests without
Docker. The manual **Container image smoke test** GitHub workflow builds the image
and checks its installed tools. A real Cloudflare deployment is still needed to
verify outbound interception and platform process recovery for your account.

The Cloudflare image targets AMD64. Building on an ARM workstation requires AMD64
emulation; the manual workflow uses an AMD64 runner. See the [Cloudflare outbound
traffic documentation](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
for the platform interception contract.
