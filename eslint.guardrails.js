// Lint guardrails shared by every package; the reasoning lives in docs/agents/typescript.md. A new rule that meets
// existing violations grandfathers them with `eslint --suppress-rule`; fix them, never add to them.

const see = "See docs/agents/typescript.md.";

export const restrictedSyntax = [
  { selector: "Decorator", message: "No decorators in karmi (ADR-0002)." },
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

export const rules = {
  "@typescript-eslint/no-non-null-assertion": "error",
  "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
};
