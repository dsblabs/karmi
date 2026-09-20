# @karmi/sandbox-container internals

This file is for contributors to `@karmi/sandbox-container`. The use of the container sandbox is in the [Sandbox guide page](../../docs/guide/07-sandbox.md). The terms with capitals are in the [glossary](../../CONTEXT.md).

## Source areas

| File                  | Function                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `Dockerfile`          | The container image. It adds Python libraries, Node, ffmpeg and jq to the Cloudflare Sandbox SDK image. |
| `src/index.ts`        | `LocalProcessSandbox`, which extends `CloudflareContainerSandbox` from `@karmi/core`.                   |
| `src/local-driver.ts` | `LocalContainerDriver`, which runs shell and Python processes on the host in a temporary directory.     |

`LocalContainerDriver` implements the `ContainerDriver` interface from `container-types.ts` in `@karmi/core`. The container adapter in `@karmi/core` has the lifecycle: the run, the change to a Job, the poll and the cancel. Thus the local runtime and the Cloudflare runtime share that code, and only the driver is different.

## Rules that the code cannot show

- Keep the version of the Sandbox SDK package and the version of the base image in the `Dockerfile` the same.
- Do not put credentials in the image. A Script gets no Tool bridge and no secrets from the host environment.
- `LocalProcessSandbox` is for trusted development scripts only. It does not isolate host files and does not enforce the egress rules.
- The local driver changes literal `/in` and `/out` paths in the code to the temporary directory. It cannot change a path that the code builds at run time.
- The image is for AMD64. A build on an ARM machine needs AMD64 emulation.

## Tests

- `test/local.test.ts` runs shell and Python processes on the host. It does not need Docker. Run it with `pnpm --filter @karmi/sandbox-container test`.
- The manual GitHub workflow `.github/workflows/container-smoke.yml` builds the image and checks the installed tools.
- No test covers the outbound interception or the process recovery of the Cloudflare platform. Do a deploy to Cloudflare to check them.
