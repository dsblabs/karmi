import tseslint from "typescript-eslint";

// The compatibility baseline (ADR-0002): no decorators anywhere. An adapter may use Node builtins; this one needs none.
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "no-restricted-syntax": ["error", { selector: "Decorator", message: "No decorators in karmi (ADR-0002)." }],
  },
});
