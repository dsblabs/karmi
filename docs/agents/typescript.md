# TypeScript

The detail behind the TypeScript section of `AGENTS.md`. Read the section for the rule you are about to bend.

## Tooling first

Formatting, unsafe casts, function length and error codes are enforced by the formatter, the linter and the type checker. Run all three before you finish.

Violations that predate a lint rule live in an ESLint suppressions file. Never add to it. When you fix a suppressed violation, prune the file with `eslint --prune-suppressions`. A new rule that meets existing violations gets `--suppress-rule <rule>`, never `--suppress-all`.

## Narrow, don't assert

A cast or a non-null assertion tells the compiler to stop checking. Use a type guard, a default, or a type that already says what you know. When a third-party type is genuinely wrong, cast once at that boundary and say why in a comment.

## Decode data at the boundary, once per shape

Anything that crosses a process boundary is untrusted: stored JSON, network payloads, RPC arguments. Give each shape one decode function, next to the type it produces, and make every caller use it. A shape change then has one place to handle old data.

## Derive state once, then pass it down

Reading and parsing state costs I/O and CPU. Load it once per unit of work and hand the result to helpers, instead of letting each helper re-read it. Never keep a copy captured before a write and use it beside a fresh read. Re-read at one clear point, or have the write return the new state.

## One source of truth

If you are about to write "mirrors X" or "keep in sync with X", extract a shared function instead. Derive static types from runtime schemas. Write a type by hand only for readability, and add a test that pins it to the schema.

## One error style per layer

- A layer either returns result values or throws. It doesn't mix the two.
- Don't throw an error only to catch it and convert it a few lines up.
- Reuse the existing result type and its constructors. Don't invent a new `{ ok, ... }` shape.
- Error codes form one closed union with one naming convention. A new failure adds its code to the union.

## Make invalid states unrepresentable

Model mutually exclusive outcomes as a discriminated union. Each branch contains only the data valid for that outcome: for example, a successful validation result carries its normalized value and warnings, while a failed result carries issues. Do not combine a boolean discriminator with optional success and failure fields in one interface.

## Keep pure logic apart from I/O

Folding events, computing limits and deciding the next action are pure functions over plain data. Put them in their own module and test them without storage, network or timers. Stateful and I/O-owning classes keep only the I/O.

## Persistence schema

The create statements always describe the current schema. Migrations for older data are versioned and run once. Don't probe the live schema on every startup. Break long queries across lines, because formatters never split strings.

## Ids and keys

Build every storage key, job id and cache key in one function. The code that creates an id and the code that looks it up or cancels it must call the same helper.

## Tests

Wait on a condition, not a timer. A fixed sleep is either too slow or flaky.
