import tseslint from "typescript-eslint";
import {
  extensionlessImportPattern,
  extensionlessImportRules,
  rawSqlExecSyntax,
  restrictedSyntax,
  rules,
  jsdocPlugin,
  jsdocRules,
} from "../../eslint.guardrails.js";

const errorConditionalSyntax = {
  selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error']",
  message: "Use errorMessage() from errors.ts.",
};
const coreRestrictedSyntax = [...restrictedSyntax, errorConditionalSyntax];
const databaseRestrictedSyntax = coreRestrictedSyntax.filter((rule) => rule !== rawSqlExecSyntax);

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
    ignores: ["src/vendor/**"],
    plugins: jsdocPlugin,
    rules: {
      ...jsdocRules,
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
      "no-restricted-syntax": ["error", ...coreRestrictedSyntax],
    },
  },
  {
    files: ["src/db/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...databaseRestrictedSyntax] },
  },
);
