import tseslint from "typescript-eslint";
import {
  extensionlessImportPattern,
  extensionlessImportRules,
  jsdocPlugin,
  jsdocRules,
  restrictedSyntax,
  rules,
} from "../../eslint.guardrails.js";

// The compatibility baseline (ADR-0002): no decorators anywhere. This package reaches karmi through the
// public `@karmi/core` entry only, so the package's tests can stand in for any Worker that mounts it.
export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: extensionlessImportRules,
  },
  {
    files: ["src/**/*.ts"],
    plugins: jsdocPlugin,
    rules: {
      ...jsdocRules,
      ...rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            extensionlessImportPattern,
            {
              group: ["@karmi/core/*", "**/packages/core/**", "../../core/**", "../core/**"],
              message: '@karmi/http uses the public Thread API only: import from "@karmi/core".',
            },
            { group: ["node:*"], message: "@karmi/http imports no node:* builtins (ADR-0002)." },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
);
