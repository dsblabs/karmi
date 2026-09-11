import tseslint from "typescript-eslint";
import { extensionlessImportRules, restrictedSyntax, rules } from "../../eslint.guardrails.js";

// The compatibility baseline (ADR-0002): no decorators anywhere. An adapter may use Node builtins; this one needs none.
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
    rules: { ...rules, "no-restricted-syntax": ["error", ...restrictedSyntax] },
  },
);
