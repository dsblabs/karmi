# TypeScript

This file gives the detail for the TypeScript section of `AGENTS.md`. Before you make an exception to a rule, read the section for that rule.

## Tooling first

The formatter, the linter and the type checker enforce the rules for formatting, unsafe casts, function length and error codes. Run all three before you finish.

An ESLint suppressions file lists the violations that are older than a lint rule. Do not add to it. When you fix a suppressed violation, run `eslint --prune-suppressions` to remove it from the file. When a new rule finds existing violations, use `--suppress-rule <rule>`. Do not use `--suppress-all`.

## Narrow types, do not assert them

A cast or a non-null assertion tells the compiler to stop checking. Use a type guard, a default, or a type that already contains what you know. When a third-party type is wrong, cast one time at that boundary. Give the reason in a comment.

## Decode data at the boundary, once per shape

Do not trust data that crosses a process boundary. Stored JSON, network payloads and RPC arguments are examples. Give each shape one decode function. Put the function next to the type that it produces, and make every caller use it. Then a change to the shape has one place that handles old data.

## Derive state once, then pass it down

To read and parse state uses I/O and CPU. Load the state one time for each unit of work and pass the result to the helpers. Do not let each helper read it again. Do not keep a copy from before a write and use it together with a new read. Read the state again at one clear point, or make the write return the new state.

## One source of truth

If you start to write "mirrors X" or "keep in sync with X", extract a shared function. Derive static types from runtime schemas. Write a type by hand only when it is easier to read. Then add a test that fails when the type and the schema differ.

## One error style per layer

- A layer returns result values or it throws. It does not do both.
- Do not throw an error and then catch and convert it a few lines above.
- Use the existing result type and its constructors. Do not make a new `{ ok, ... }` shape.
- Error codes are one closed union with one naming convention. For a new failure, add its code to the union.

## Make invalid states unrepresentable

When only one of a set of outcomes can occur, model the outcomes as a discriminated union. Each branch contains only the data that is valid for that outcome. For example, a successful validation result has its normalized value and its warnings. A failed result has its issues. Do not put a boolean discriminator and optional success and failure fields in one interface.

## Keep pure logic apart from I/O

These operations are pure functions of plain data: to fold events, to calculate limits and to decide the next action. Put them in their own module. Test them without storage, network or timers. A class that has state or does I/O keeps only the I/O.

## Persistence schema

The schema file of each Durable Object is the source of truth. Run `pnpm db:generate` to generate versioned migrations from it. Each migration runs one time. Do not edit or combine a generated migration after you merge it. Do not examine the live schema on each startup.

One SQL statement of a Durable Object binds at most 100 values. A statement above the limit fails with `too many SQL variables`. An inserted row binds one value for each column, and an `IN` list binds one value for each entry. When the length of a list comes from data, split the list with `boundBatches()` from `packages/core/src/db/bound-values.ts` and run one statement for each batch. Take a limit on a batch from `MAX_BOUND_VALUES`. The linter refuses a spread, `map`, `slice` or `filter` result as the argument of `.values()`, `inArray()` or `notInArray()`. Test a list statement with more than 100 entries, because a short list hides the failure.

## Ids and keys

Build every storage key, job id and cache key in one function. The code that creates an id must call the same helper as the code that finds or cancels it.

## Tests

Wait for a condition. Do not wait for a timer. A fixed sleep is too slow, or it makes the test fail at random.
