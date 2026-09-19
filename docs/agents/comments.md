# Code comments

This file gives the detail for the comments rule in `AGENTS.md`. The reader of a comment has not read the rest of the codebase. Write for that reader.

## Two kinds of comment

**JSDoc (`/** */`) is a contract.** It sits on a symbol. It tells what the symbol is and how to use it. Every export of a package's `index.ts` must have one. The linter enforces this rule for every exported symbol. An editor shows the JSDoc on hover, so it is the first documentation that a developer reads. Frequently it is the only documentation.

**Line comments (`//`) explain a why.** They sit inside a function body. They tell why the code does not use the obvious approach. Do not put a `//` above an export in place of JSDoc.

## JSDoc

- **Lead with what.** The first sentence names the thing or tells what the function does. Example: "Retries `fn` up to `attempts` times with exponential backoff." Put reasons and design history after that sentence, or leave them out.
- **Then only what a caller needs.** Give the defaults, the failure behaviour, the things that the symbol never does, and the other API that completes it. Do not describe the implementation.
- **Document the members.** Write one line for each field of a public interface and for each option of a public function. You can leave out the line when the name is sufficient. A type that has a documented header and undocumented fields is not complete.
- **Match the shape.** A function doc tells what the function returns. A type doc tells what a value of that type represents. A constant doc tells what the value limits.

## Every comment

The language rules for all prose are in `docs/agents/writing.md`. They apply to every comment. These rules apply only to comments:

- **No project references.** Do not write issue numbers, ticket names, "v0", "reserved for later" or "replaced when X lands". Put status in the issue tracker. Do not put it in the source.
- **Wrap by hand.** Prettier does not wrap comments. Keep each line shorter than the print width of the formatter.

## Why-comments

Keep a `//` only where a reader could change the code and break it. These are the usual cases:

- An ordering constraint.
- Unusual behaviour of the platform.
- A security boundary.
- A cast that a third-party type makes necessary.

Write the constraint. Do not write your opinion of it. Refer to a doc, an ADR or a research note when one exists. Delete a `//` that repeats the next line. Delete a `//` when a better function name can replace it.

## Examples from this repo

Keep this comment:

```ts
/** The first firing strictly after `after`, as epoch milliseconds, or undefined when the expression is invalid or never fires. */
```

Rewrite these comments:

```ts
/** Every Hook sees where it runs; nothing is ambient. */
// becomes
/** The context every Hook receives. It carries the Scope, Thread and Turn the Hook runs in. */
```

```ts
/** JSON-Schema-native so an MCP tool's result is the same shape. */
// becomes
/** The result of one Tool call: content blocks plus an error flag. It uses the MCP result shape so an MCP tool's result needs no conversion. */
```

```ts
/** Summed over every completed model Step; the Usage-record ticket replaces this placeholder. */
// becomes
/** Token usage summed over every completed model Step of the Thread. */
```
