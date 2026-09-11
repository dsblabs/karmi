import tseslint from "typescript-eslint";
import { restrictedSyntax, rules } from "../../eslint.guardrails.js";

// The compatibility baseline (ADR-0002): no decorators anywhere. An adapter may use Node builtins; this one needs none.
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: { ...rules, "no-restricted-syntax": ["error", ...restrictedSyntax] },
});
