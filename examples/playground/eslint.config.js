import tseslint from "typescript-eslint";
import { extensionlessImportRules, jsdocPlugin, jsdocRules, restrictedSyntax, rules } from "../../eslint.guardrails.js";

// The setup command runs under Node, so it may import `node:*` and must import with the `.ts` extension.
export default tseslint.config(
  { ignores: ["**/.wrangler/**", "public/**", "test-results/**", "playwright-report/**"] },
  {
    files: ["**/*.{ts,mts}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: extensionlessImportRules,
  },
  {
    files: ["src/**/*.ts", "setup/**/*.ts"],
    plugins: jsdocPlugin,
    rules: { ...jsdocRules, ...rules, "no-restricted-syntax": ["error", ...restrictedSyntax] },
  },
);
