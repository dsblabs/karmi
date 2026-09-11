// Lint guardrails shared by every package; the reasoning lives in docs/agents/typescript.md. A new rule that meets
// existing violations grandfathers them with `eslint --suppress-rule`; fix them, never add to them.

const see = "See docs/agents/typescript.md.";

const extensionlessImportSyntax = [
  {
    selector: String.raw`ImportExpression[source.value=/^\.{1,2}\/.*\.js$/]`,
    message: "Omit .js from relative TypeScript imports.",
  },
  {
    selector: String.raw`TSImportType[source.value=/^\.{1,2}\/.*\.js$/]`,
    message: "Omit .js from relative TypeScript imports.",
  },
  {
    selector: String.raw`CallExpression[callee.name='require'][arguments.0.value=/^\.{1,2}\/.*\.js$/]`,
    message: "Omit .js from relative TypeScript imports.",
  },
  {
    selector: String.raw`TSExternalModuleReference[expression.value=/^\.{1,2}\/.*\.js$/]`,
    message: "Omit .js from relative TypeScript imports.",
  },
];

export const restrictedSyntax = [
  { selector: "Decorator", message: "No decorators in karmi (ADR-0002)." },
  ...extensionlessImportSyntax,
  {
    selector: "TSAsExpression > TSAsExpression.expression",
    message: `No double casts. Narrow the value or fix the type. ${see}`,
  },
  {
    selector: "TSAsExpression > TSNeverKeyword.typeAnnotation",
    message: `No \`as never\`. Narrow the value or fix the type. ${see}`,
  },
  {
    selector: "TSAsExpression > CallExpression.expression[callee.object.name='JSON'][callee.property.name='parse']",
    message: `Don't cast JSON.parse inline. Decode each stored or remote shape in one function. ${see}`,
  },
];

export const extensionlessImportPattern = {
  regex: String.raw`^\.{1,2}/.*\.js$`,
  message: "Omit .js from relative TypeScript imports.",
};

export const extensionlessImportRules = {
  "no-restricted-imports": ["error", { patterns: [extensionlessImportPattern] }],
  "no-restricted-syntax": ["error", ...extensionlessImportSyntax],
};

export const rules = {
  "@typescript-eslint/no-non-null-assertion": "error",
  "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
};
