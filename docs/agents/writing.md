# Writing rules

These rules apply to all prose in karmi: docs, READMEs, JSDoc, code comments, issue answers and changeset text. They are based on ASD-STE100 Simplified Technical English (STE). We use the STE writing rules. We do not use the STE dictionary, and we do not claim STE compliance. Rules that apply only to code comments are in `docs/agents/comments.md`.

A prose linter (Vale) checks some of these rules. You must apply all of them, including the rules that the linter does not check.

To run the linter, install [Vale](https://vale.sh/docs/install) and run `pnpm prose:check`. CI fails on errors. The linter also shows warnings for long sentences and the passive voice. Fix a warning when you change the text near it. After you change an `_Avoid_` line in `CONTEXT.md`, run `pnpm prose:terms` to update the term rule.

## Sentences

- Write at most 20 words in an instruction.
- Write at most 25 words in a description.
- Count a code span or a term in backticks as one word.
- Write one instruction in each sentence.
- Write one topic in each paragraph. Write at most 6 sentences in a paragraph.
- Write full sentences. Do not write fragments that start with a colon.
- Use a vertical list when a sentence has more than three items or steps.

## Voice and tense

- Use the active voice. Write "The Harness starts the Turn", not "The Turn is started".
- Use the present tense for facts.
- Use the imperative for instructions. Write "Run `pnpm test`", not "You should run `pnpm test`".
- Use "you" for the reader.
- Use "must" for a requirement. Do not use "should" for a requirement.

## Words

Use one word for one meaning. When you have a word for a thing, use the same word each time.

You can use these words without a definition:

- The terms in `CONTEXT.md`. Write each term with the capitals that `CONTEXT.md` uses, for example Harness, Turn and Scope.
- Code identifiers in backticks, for example `defineAgent`.
- Product names, for example Cloudflare Workers, Durable Objects and Vale.
- Common words that a TypeScript developer knows, for example function, type, promise, request and deploy.

Define each other technical term in the sentence that first uses it. If the term occurs in many places, add it to `CONTEXT.md`.

Use the simple word:

<!-- vale Karmi.Wordiness = NO -->

| Use   | Do not use                 |
| ----- | -------------------------- |
| use   | leverage, utilize          |
| start | kick off, spin up          |
| stop  | tear down, shut down       |
| show  | surface, showcase          |
| help  | empower, enable (a person) |
| about | around (a topic)           |

<!-- vale Karmi.Wordiness = YES -->

The Vale style in `.vale/styles/Karmi/` has the full lists of banned words and replacement words. That style is the single source of truth for the lists. Do not copy the lists into other docs.

## AI filler

Do not write text that gives the reader no information. These patterns are not permitted:

<!-- vale Karmi.AIFiller = NO -->

- Openers and closers. Examples: "In this guide, we will…", "In summary…", "Happy coding!".
- Intensifiers and hedges. Examples: "simply", "just", "easily", "very", "powerful", "seamless", "robust", "it's worth noting".
- Metaphors, slogans and wit. Example: "keeps the snapshot honest". Tell the fact in plain words.
- Groups of three items that you add only for rhythm.
- "Not X but Y" contrasts.
- A question that the next sentence answers.
- An em dash that breaks a sentence. Write two sentences.
- Bold on phrases in the middle of the text.
- Emoji.
- A heading that is a slogan. A heading gives the name of the topic.

<!-- vale Karmi.AIFiller = YES -->

Use the `/unslop` skill on your prose before you commit it.

## Code samples

- Make each sample complete. It must type-check and run as shown, with its imports.
- Import from the public package entry, for example `@karmi/core`. Do not import from internal paths.
- Show one point in each sample. Keep the sample as short as possible.
- Do not put `...` gaps in code that the reader will copy.
- Add a language tag to each code block, for example `ts` or `sh`.
- Write one sentence before the block. The sentence tells what the code does.
- Use realistic names, for example `supportAgent` and `searchOrders`. Do not use `foo` or `bar`.
- Use `pnpm` in shell commands.

## Changeset text

Users read changeset text in the changelog and in the npm release notes.

- Write one changeset for each change that a user can see.
- Start with a verb in the past tense: "Added", "Fixed", "Changed" or "Removed". This is the only exception to the present tense rule.
- Tell what changed for the user. Do not describe the implementation.
- For a breaking change, tell what breaks. Then give the migration steps, with a code sample before and after the change.
- Do not write issue numbers or internal names. The changelog links to the pull request.
