import tseslint from "typescript-eslint";
import {
  extensionlessImportPattern,
  extensionlessImportRules,
  restrictedSyntax,
  rules,
} from "../../eslint.guardrails.js";

// The compatibility baseline (ADR-0002): no `node:*` in core, no decorators anywhere.
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
    rules: {
      ...rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            extensionlessImportPattern,
            { group: ["node:*"], message: "@karmi/core imports no node:* builtins (ADR-0002)." },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        {
          selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error']",
          message: "Use errorMessage() from errors.ts.",
        },
      ],
    },
  },
);
