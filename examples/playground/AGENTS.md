# Playground rules

These rules apply to each change below `examples/playground`. The rules of the repository in [`AGENTS.md`](../../AGENTS.md) also apply.

## UI changes

A UI change is a change to a file in `public/`. Read [`docs/ui.md`](./docs/ui.md) before you make one. It has the layout, the components and the states of the page.

The short rules:

- Put new content in a component that `docs/ui.md` lists. Do not add a style for one element id.
- Put each piece of content in the zone where it belongs: title bar, conversation, composer or side column.
- Show data that the operator watches. Put reference data in a closed `details.card`.
- Show data of the Framework, for example JSON, in `code` or `pre`. Do not put it in a sentence.
- Give each action a result that the operator sees at once.
- Add each CSS rule before the media queries of `style.css`, in the section of its component.
- Use the colour variables of `:root`. They give the light and the dark colours.

## Checks

Run `pnpm test:browser` after a UI change. The test `each view fits a … screen` opens each built scenario at a desktop, a tablet and a mobile size. It fails when content is wider than the page or a button is too small for a finger. Do not change this test to make a new view pass. Change the view.

Look at the page at the three sizes before you finish. `docs/ui.md` tells how to take the screenshots.
