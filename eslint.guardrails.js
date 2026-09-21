// Lint guardrails shared by every package; the reasoning lives in docs/agents/typescript.md. A new rule that meets
// existing violations grandfathers them with `eslint --suppress-rule`; fix them, never add to them.

import jsdoc from "eslint-plugin-jsdoc";

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

/** Rejects direct use of a Durable Object's raw SQL execution escape hatch. */
export const rawSqlExecSyntax = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='exec'][callee.object.type='MemberExpression'][callee.object.property.name='sql']",
  message: "Use the owning db module instead of calling storage.sql.exec directly.",
};

const boundValues =
  "One SQL statement of a Durable Object binds at most 100 values. Split the list with boundBatches() from db/bound-values.ts.";

/** A list of unknown length must not reach one SQL statement, because each entry binds a value. */
export const boundValuesSyntax = [
  {
    selector:
      "CallExpression[callee.property.name='values'] > :matches(ArrayExpression:has(SpreadElement), CallExpression[callee.property.name=/^(map|slice|filter|flatMap)$/]).arguments",
    message: boundValues,
  },
  {
    selector:
      "CallExpression[callee.name=/^(inArray|notInArray)$/] > :matches(ArrayExpression:has(SpreadElement), CallExpression[callee.property.name=/^(map|slice|filter|flatMap)$/]).arguments",
    message: boundValues,
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
  rawSqlExecSyntax,
  ...boundValuesSyntax,
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

// Every exported symbol carries a JSDoc contract; see docs/agents/comments.md.
export const jsdocPlugin = { jsdoc };
export const jsdocRules = {
  "jsdoc/require-jsdoc": [
    "error",
    {
      publicOnly: true,
      require: { FunctionDeclaration: true, ClassDeclaration: true },
      contexts: [
        "TSInterfaceDeclaration",
        "TSTypeAliasDeclaration",
        "TSEnumDeclaration",
        "ExportNamedDeclaration > VariableDeclaration",
      ],
    },
  ],
  "jsdoc/require-description": ["error", { contexts: ["any"] }],
};
