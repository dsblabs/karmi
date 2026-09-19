# Prose linting for technical English

Research note, 2026-09-19. This note uses primary sources only. It answers [Which prose linter can check Simplified Technical English and AI filler words in CI?](https://github.com/dsblabs/karmi/issues/131).

## Recommendation

Use Vale CLI with a small local `Karmi` style. Add the maintained Microsoft package for its sentence-length and passive-voice rules. Run Vale as a separate GitHub Actions job. Do not put it inside every package's `lint` task.

Vale fits this repository better than the alternatives. It parses Markdown before it checks prose. It omits fenced code, inline code, link targets, and front matter by default. Rules can also select headings, lists, tables, or normal text [vale-markup]. Local YAML rules can hold banned phrases and term substitutions [vale-rules]. The official action can sync packages, annotate a pull request, and fail at a chosen severity [vale-action].

This is an ASD-STE100-inspired check, not an ASD-STE100 checker. ASD says that software does not replace the specification. It also says that checkers vary in accuracy [asd-software]. No maintained Vale package in the official package library implements ASD-STE100 [vale-packages].

Start with rules that give useful, repeatable results:

| Rule | First severity | Implementation |
|---|---:|---|
| AI filler and banned phrases | error | Local `existence` and `substitution` rules |
| Project terminology | error for exact forbidden terms | Generate local substitutions from the `_Avoid_` entries in `CONTEXT.md` |
| Sentence length | warning | Microsoft `SentenceLength`, changed from 30 to 25 words |
| Passive voice | warning | Microsoft `Passive` |
| One instruction per sentence | off | Add only after a measured prototype has acceptable noise |
| Approved STE words | off | Add only with a licensed word list and a maintained technical-term glossary |

Gate new errors first. Keep sentence length and passive voice advisory until the existing corpus is clean. This avoids a large baseline that teaches writers to ignore the tool.

## What ASD-STE100 needs

The official ASD guidance says that a checker should find long sentences, long noun clusters, and passive voice. A word checker must use a company glossary for technical nouns and technical verbs [asd-software]. The STE dictionary controls the approved meaning and part of speech, not only the spelling of a word [asd-faq]. A flat allowlist cannot check those meanings.

For this project, the practical targets are:

| Check | Can a deterministic linter do it? | Limit |
|---|---|---|
| Sentence length | Yes | The checker must count words, not source lines. |
| Passive voice | Partly | Pattern rules have false positives and miss unusual forms. |
| Approved words | Partly | A word list cannot check approved meaning or part of speech. |
| One instruction per sentence | Partly | Conjunction and imperative patterns are only proxies for intent. |
| Project terms | Yes | Exact terms and preferred replacements are deterministic. |

The official site also warns that technical names and technical verbs can contain otherwise unapproved words [asd-faq]. Karmi has many such terms. Examples include Agent Spec, Scope, Turn, Step, Durable Object, and Provider profile. Any approved-word check must import those terms from `CONTEXT.md` or it will produce noise.

## Tool comparison

### Vale

Vale is an active, MIT-licensed Go CLI. It runs offline and supports custom YAML rules, published style packages, and GitHub Actions [vale-repo]. Its official package library includes Microsoft, Google, Red Hat, `write-good`, `proselint`, and `alex` [vale-packages]. These are plain-language or house-style packs. They are not STE packs.

The Microsoft package is the best base here. It has an explicit 30-word sentence rule and a passive-voice pattern [microsoft-length] [microsoft-passive]. Its own coverage report says that it implements 57.8 percent of the guide topics and 12.5 percent of the A-Z word list. It is not maintained or endorsed by Microsoft [microsoft-readme]. This honesty is useful. Treat it as tested rules, not as a complete style guide.

Vale covers the requested checks as follows:

| Need | Vale result |
|---|---|
| Sentence length | Direct. An `occurrence` rule can count word tokens in each sentence. |
| Passive voice | Available in Microsoft and Google. Both use a `be` verb plus participle pattern. |
| Approved words | Partial. `spelling` supports vocabularies, but a full STE check needs the controlled dictionary, parts of speech, meanings, and technical-term exceptions. |
| One instruction per sentence | No reliable packaged rule. A scoped list-item rule can flag likely conjunctions, but it cannot count intent. |
| AI filler | Direct. Local `existence` or `substitution` rules can flag words and phrases. |
| Markdown code | Strong. Code blocks and code spans do not reach prose rules [vale-markup]. |
| Project terms | Strong. A local vocabulary can accept names. Substitution rules can enforce the `_Avoid_` terms from `CONTEXT.md`. |
| CI | Strong. A native action supports package caching, file selection, annotations, and severity gates [vale-action]. |

The Red Hat project is a serious maintained Vale configuration, but it applies Red Hat and IBM documentation rules. It is evidence that large documentation teams can maintain Vale rules. It is not a reusable STE package [red-hat-vale].

### textlint

textlint is an active Node.js linter. It supports Markdown and plain text by default. It has no bundled rules, so each rule is a separate npm dependency [textlint-repo]. It fits pnpm without a separate binary install and can run as a root script.

Its English coverage is weaker for this task. The maintained sentence-length rule counts characters, not words [textlint-sentence-length]. The textlint documentation shows how to build an English word-count rule, which means custom TypeScript can fill the gap [textlint-custom-rule]. The Google preset still marks active voice as unimplemented [textlint-google]. Approved vocabulary and one-instruction checks would also require custom rules.

textlint parses Markdown into nodes. Rules can ignore or inspect code nodes, and filter rules can suppress any node range [textlint-filter]. This works, but each third-party rule must handle the tree correctly. Vale's default exclusion of code is safer for a mixed rule set.

Choose textlint only if one runtime and fully programmable TypeScript rules matter more than ready prose rules. Karmi would own more rule code and more dependencies.

### remark-lint

remark-lint is mature Markdown tooling with about 70 rules and three presets. Its rules focus on Markdown structure. The published list has wrappers for `write-good`, line length, heading length, and related syntax checks [remark-lint]. It has no coherent rule set for approved STE words or one instruction per sentence.

remark-lint is a good companion for Markdown syntax. It is not the main prose linter for this question.

### Dedicated open-source STE checkers

Two recent projects claim closer STE coverage. `sourdough-bread/asd-ste100-checker` reports sentence length, passive voice, and unapproved vocabulary [asd-checker]. `stuffbucket/vale` reports sentence length, passive voice, one instruction, and an OpenSTE vocabulary [stuffbucket-vale]. Neither has the adoption or maintenance history needed for a required repository gate. Both repositories were created in July 2026. The latter also uses the name `vale`, but it is unrelated to Vale CLI.

These tools are useful prototype subjects. Do not adopt either as the first CI dependency. Revisit them when the project is ready to test a strict vocabulary rule against the full corpus.

## First configuration

Keep the first local style small:

1. Add `Karmi.AIFiller` as an error. Start with the terms already rejected by the writing policy: `additionally`, `crucial`, `delve`, `enhance`, `fostering`, `interplay`, `intricate`, `pivotal`, `showcase`, `tapestry`, `testament`, `underscore`, and abstract uses of `landscape`. Add multiword filler such as `in order to`, `due to the fact that`, and `it is important to note that` with replacements.
2. Add `Karmi.Terms` as an error. Generate its substitutions from the `_Avoid_` lines in `CONTEXT.md`. Keep the generated rule in the repository and add a check that fails when generation changes it.
3. Enable Microsoft sentence length at 25 words as a warning. Add a second 20-word list-item rule only after tests show that prose lists in this repository mostly contain procedures.
4. Enable Microsoft passive voice as a warning.
5. Add rule fixtures for true positives, false positives, Markdown code, links, and project terms.

Do not start with the whole Microsoft, Google, or `write-good` package enabled. Their rules encode guidance that the project did not choose. For example, `write-good` has a fixed list of "weasel words," while this project already has a more precise banned list [write-good-weasel]. Import only the two tested Microsoft rules, or copy them into the local style with their licences and source notes.

Do not gate an STE approved-word rule yet. First obtain a word list that the project can redistribute. Then generate the technical-term allowlist from `CONTEXT.md`. Test the combined list against representative documentation before it reaches CI.

## Repository integration

Add a root `prose:check` command that runs Vale over `README.md`, `CONTEXT.md`, `docs/`, and other human-written Markdown. Exclude generated files, vendored files, changelogs, and issue exports. Vale is not an npm package requirement. Install a pinned binary in CI, and document one local install command.

Use a separate `prose` job in `.github/workflows/ci.yml`. The official action can cache the synced style directory and can fail on errors while it reports warnings [vale-action]. A separate job gives direct annotations and does not make every Turbo package depend on a documentation tool.

If the team wants one local command, make the root pnpm script call Vale. Do not add a `prose:check` task to each workspace. Turbo adds no value when one process scans a shared document tree. If prose checks later become package-owned, add a Turbo task with no outputs.

## Decision

Adopt Vale CLI. Start with deterministic local rules, Microsoft sentence length, and Microsoft passive voice. Keep semantic STE checks advisory or off until corpus tests measure their noise. Generate project terminology from `CONTEXT.md` so the domain model remains the source of truth.

[asd-checker]: https://github.com/sourdough-bread/asd-ste100-checker
[asd-faq]: https://www.asd-ste100.org/faq.html
[asd-software]: https://www.asd-ste100.org/STEsoftware.html
[microsoft-length]: https://github.com/vale-cli/Microsoft/blob/master/Microsoft/SentenceLength.yml
[microsoft-passive]: https://github.com/vale-cli/Microsoft/blob/master/Microsoft/Passive.yml
[microsoft-readme]: https://github.com/vale-cli/Microsoft/blob/master/README.md
[red-hat-vale]: https://github.com/redhat-documentation/vale-at-red-hat
[remark-lint]: https://github.com/remarkjs/remark-lint
[stuffbucket-vale]: https://github.com/stuffbucket/vale
[textlint-custom-rule]: https://github.com/textlint/textlint/blob/master/docs/rule-advanced.md
[textlint-filter]: https://github.com/textlint/textlint/blob/master/docs/filter-rule.md
[textlint-google]: https://github.com/textlint-rule/textlint-rule-preset-google
[textlint-repo]: https://github.com/textlint/textlint
[textlint-sentence-length]: https://github.com/textlint-rule/textlint-rule-sentence-length
[vale-action]: https://github.com/vale-cli/vale-action
[vale-markup]: https://vale.sh/features/markup
[vale-packages]: https://github.com/vale-cli/packages
[vale-repo]: https://github.com/vale-cli/vale
[vale-rules]: https://vale.sh/
[write-good-weasel]: https://github.com/vale-cli/write-good/blob/master/write-good/Weasel.yml
