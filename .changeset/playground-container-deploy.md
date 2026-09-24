---
"@karmi/core": patch
---

Fixed `pnpm deploy` of the Playground:

- The command no longer fails with a JSON syntax error when it reads `wrangler.jsonc`.
- A deployment made before container Scripts can now add them. Run `pnpm deploy <name>` again and answer yes.
- The container application uses the instance type `basic`. With the default type `lite`, Cloudflare could not unpack the image, and each container Script failed.
- The command prints the address of the Worker at the end.

The container sandbox section of the deployment guide now tells you to use the instance type `basic` or a larger one.
