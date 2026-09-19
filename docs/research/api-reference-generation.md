# API reference generation

Research note, 2026-09-19. This note uses primary sources only. It answers [How do we generate the API reference from JSDoc?](https://github.com/dsblabs/karmi/issues/135).

## Recommendation

Use TypeDoc with `typedoc-plugin-markdown`. Generate the reference in CI. Do not commit the generated files at first.

TypeDoc is the smallest fit for this repository. It reads TypeScript source and follows exports and re-exports [typedoc]. It can also find entry points from the `exports` field in `package.json` [typedoc-input]. The Markdown plugin renders the TypeDoc model as plain Markdown [markdown-output].

Use the plugin's default `member` router for `@karmi/core`. It creates one page for each exported member and groups the pages by kind. This gives stable, direct links to symbols. The `module` router puts each entry point in one file [markdown-output]. That layout is useful for small packages, but the main `@karmi/core` page is too large.

## Trial on `@karmi/core`

The trial used TypeDoc 0.28.20 and the current `typedoc-plugin-markdown`. TypeDoc found the entry points from `packages/core/package.json` without a separate list:

- `@karmi/core`
- `@karmi/core/testing`
- `@karmi/core/sandbox`

It ignored the JSON export. It followed the re-exports in each TypeScript entry point. This matches the documented TypeDoc behavior [typedoc] [typedoc-input].

The default `member` router generated 346 Markdown files and used 1.5 MB. A page such as `createKarmi` showed the signature, the one-sentence JSDoc summary, type parameters, parameters, and return type. The result reads well when the JSDoc explains behavior that the signature cannot show.

The `module` router generated three files and used about 310 KB. The main entry-point file had 13,666 lines. This is too long for a useful reference page. Keep the default `member` router for core.

The trial reported 34 warnings for exported types that refer to types which are not exported. These warnings are useful. Fix the public type boundaries or list intentional cases before warnings become CI errors. Do not hide the warnings as part of the first setup.

TypeDoc uses the export graph as the reference boundary. This is better than scanning `src`. It prevents internal modules from becoming reference pages just because they exist.

## Proposed setup

Add `typedoc` and `typedoc-plugin-markdown` as pinned root development dependencies. Add one root configuration with these main choices:

- Read package entry points from each package's `exports` field.
- Use `entryPointStrategy: "packages"` when all packages join the reference.
- Set package conversion options through `packageOptions` or package configs. TypeDoc does not copy root conversion options into package runs [typedoc-package-options].
- Use `router: "member"`.
- Use `entryFileName: "index"` so a later site generator gets normal index pages [markdown-file-options].
- Set `readme: "none"`. The hand-written guides remain separate.
- Disable source links until the project chooses stable source URLs.
- Exclude private, protected, and `@internal` declarations.

The first implementation should start with `@karmi/core`. Add the other public packages after their exports and JSDoc meet the same rules. This keeps the first change small and exposes any package-specific problems before the monorepo setup grows.

## CI and stale output

Build the generated reference in CI and in the future docs publishing job. Do not commit it now. A generated reference has hundreds of files, so commits would add noisy diffs and merge conflicts. CI-built output cannot become stale in Git because Git does not store it.

Add a `docs:api` command that writes to `docs/reference/`. The CI job must run that command and fail when TypeDoc fails. It should also build the documentation consumer, when one exists. This checks that links and Markdown syntax work in the real target.

Enable TypeDoc validation for broken links and referenced but unexported types. Add missing-comment validation after the current public exports have JSDoc. TypeDoc can treat validation warnings as errors and can limit missing-comment checks to selected declaration kinds [typedoc-validation].

If the team later commits the generated files for GitHub browsing, CI must run the generator and then run `git diff --exit-code -- docs/reference`. TypeDoc does not provide a separate stale-file check.

## Why not API Extractor and API Documenter

API Extractor and API Documenter can generate Markdown from `.api.json` model files [api-documenter]. API Extractor also has a strong API review flow. It keeps an API report in Git and compares it with temporary output during a build [api-report]. Choose that stack if reviewed API snapshots become a product requirement.

It is too much machinery for this question. The flow needs declarations, an API Extractor configuration for each package entry point, model files, and a second documentation command. Multiple entry points also need separate configurations or a synthetic entry point. The API Extractor documentation recommends a synthetic file that re-exports multiple entry points for some features [api-rollup]. That would erase the package's real subpath structure unless more setup restores it.

TypeDoc already handles the current export map. API Documenter's Markdown does not justify the extra stages.

## Later docs sites

The generated files are plain Markdown, so a later site can consume the same content. Keep site-specific configuration outside JSDoc.

For VitePress, the Markdown plugin project provides an official adapter. It changes output for VitePress and can generate sidebar data [vitepress-plugin]. For Starlight, the normal Markdown output is usable as content, but the build must supply Starlight's required page metadata and navigation [starlight-content]. The Markdown plugin can emit navigation JSON for custom sidebars [markdown-output].

The site choice does not need to change the source comments or the TypeDoc model. It may change the renderer options and generated navigation files.

## Decision

Adopt TypeDoc with `typedoc-plugin-markdown`. Generate member pages from public package entry points. Build the files in CI and leave them uncommitted. Start with `@karmi/core`, resolve its non-exported-type warnings, and then add the other public packages.

[api-documenter]: https://api-extractor.com/pages/commands/api-documenter_markdown/
[api-report]: https://api-extractor.com/pages/setup/configure_api_report/
[api-rollup]: https://api-extractor.com/pages/setup/configure_rollup/
[markdown-file-options]: https://typedoc-plugin-markdown.org/docs/options/file
[markdown-output]: https://typedoc-plugin-markdown.org/docs/options/output
[starlight-content]: https://starlight.astro.build/guides/authoring-content/
[typedoc]: https://typedoc.org/
[typedoc-input]: https://typedoc.org/documents/Options.Input.html
[typedoc-package-options]: https://typedoc.org/documents/Options.Package_Options.html
[typedoc-validation]: https://typedoc.org/documents/Options.Validation.html
[vitepress-plugin]: https://typedoc-plugin-markdown.org/plugins/vitepress
