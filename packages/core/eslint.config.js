import tseslint from "typescript-eslint";
import { restrictedSyntax, rules } from "../../eslint.guardrails.js";

// The compatibility baseline (ADR-0002): no `node:*` in core, no decorators anywhere.
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    ...rules,
    "no-restricted-imports": [
      "error",
      { patterns: [{ group: ["node:*"], message: "@karmi/core imports no node:* builtins (ADR-0002)." }] },
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
});
