import tseslint from "typescript-eslint";
import {
  extensionlessImportPattern,
  extensionlessImportRules,
  jsdocPlugin,
  jsdocRules,
  restrictedSyntax,
  rules,
} from "../../eslint.guardrails.js";

// The scaffolder runs under Node, so unlike @karmi/core it may import `node:*`.
export default tseslint.config(
  { ignores: ["dist/**", "template/**"] },
  {
    files: ["**/*.{ts,mts,cts}"],
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
      "no-restricted-imports": ["error", { patterns: [extensionlessImportPattern] }],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
);
