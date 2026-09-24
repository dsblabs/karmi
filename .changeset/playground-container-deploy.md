---
"@karmi/core": patch
---

A cancel or a reset now ends a Turn that waits for a container Job, also when Cloudflare fails to destroy the container at once. Before, the Turn stayed parked, and each later cancel, reset or delete of the Thread failed. Now the Turn ends, and the Workspace tries the destroy again after 30 seconds. The delete of a Thread waits until the container is destroyed, thus the Scope container slot is always released.

**Reset scenario** in the Playground now also works after a reset that stopped after it deleted the Thread. Before, each later reset failed with `This Thread has been deleted.`

Fixed `pnpm deploy` of the Playground:

- The command no longer fails with a JSON syntax error when it reads `wrangler.jsonc`.
- A deployment made before container Scripts can now add them. Run `pnpm deploy <name>` again and answer yes.
- The container application uses the instance type `basic`. With the default type `lite`, Cloudflare could not unpack the image, and each container Script failed.
- The command prints the address of the Worker at the end.

The container sandbox section of the deployment guide now tells you to use the instance type `basic` or a larger one.
