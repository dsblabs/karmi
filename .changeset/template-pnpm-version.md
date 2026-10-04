---
"create-karmi": patch
---

Added a `packageManager` field to the `package.json` of a project that `create-karmi` writes. The field gives the pnpm version. Before this change, the CI workflow of a new project had no pnpm version, and its `pnpm/action-setup` step failed with "No pnpm version is specified".

For a project that you created before this change, add the field to its `package.json`:

```json
"packageManager": "pnpm@11.24.0"
```
