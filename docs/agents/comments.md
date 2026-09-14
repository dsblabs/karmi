# Code comments

The detail behind the comments rule in `AGENTS.md`. A comment is read by someone who has not read the rest of the codebase. Write for that person.

## Two kinds of comment

**JSDoc (`/** */`) is a contract.** It sits on a symbol and answers "what is this and how do I use it". Every export of a package's `index.ts` must have one; the linter enforces it for every exported symbol. An editor shows it on hover, so it is the developer's first and often only documentation.

**Line comments (`//`) explain a why.** They sit inside a body and answer "why is the code this way and not the obvious way". Never put a `//` above an export in place of JSDoc.

## JSDoc

- **Lead with what.** The first sentence names the thing or says what the function does. "Retries `fn` up to `attempts` times with exponential backoff." Reasons and design history come after, if at all.
- **Then only what a caller needs.** Defaults, what happens on failure, what the thing never does, and which other API completes it. Nothing about how it is implemented.
- **Document the members.** Every field of a public interface and every option of a public function gets its own one-liner unless the name alone is enough. A type with a documented header and undocumented fields is half done.
- **Match the shape.** A function doc says what it returns. A type doc says what a value of that type represents. A constant doc says what the value bounds.

## Every comment

- **Full sentences, one idea each.** Not a noun phrase, not a colon-led fragment, not two facts joined by a semicolon. "What the model sees in place of a spilled result" is a label. "The text the model sees in place of a spilled result." is a sentence.
- **Plain words.** No metaphor, no slogans, no wit. "Nothing is ambient", "keeps the snapshot honest" and "lands in one breath" tell the reader nothing they can act on.
- **Defined terms only.** A capitalised domain term (Turn, Step, Scope, Holder) is fine because `CONTEXT.md` defines it. Any other term of art is defined in the sentence that uses it or replaced with plain words.
- **No project references.** No issue numbers, ticket names, "v0", "reserved for later", or "replaced when X lands". Status belongs in the issue tracker, not in the source.
- **Wrap by hand.** Prettier does not wrap comments. Keep lines under the formatter's print width.

## Why-comments

Keep a `//` only where a reader would otherwise change the code and break it: an ordering constraint, a platform quirk, a security boundary, a cast a third-party type forces. Say the constraint, not the feeling about it. Cite a doc, ADR or research note when one exists. A `//` that restates the next line, or that could be a better function name, is deleted.

## Examples from this repo

Keep:

```ts
/** The first firing strictly after `after`, as epoch milliseconds, or undefined when the expression is invalid or never fires. */
```

Rewrite:

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
