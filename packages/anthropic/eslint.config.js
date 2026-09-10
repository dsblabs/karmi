import tseslint from "typescript-eslint";

// The compatibility baseline (ADR-0002): no `node:*` in core, no decorators anywhere.
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "karmi imports no node:* builtins (ADR-0002)." }] }],
    "no-restricted-syntax": ["error", { selector: "Decorator", message: "No decorators in karmi (ADR-0002)." }],
  },
});
