# Issue tracker: GitHub

The issues and PRDs for this repo are GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for a body that has more than one line.
- **Read an issue**: `gh issue view <number> --comments`. Filter the comments with `jq` and also get the labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`. Add the `--label` and `--state` filters that you need.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Add or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Find the repo from `git remote -v`. The `gh` CLI does this for you when you run it inside a clone.

## Pull requests in triage

**PRs as a request surface: no.**

The `/triage` skill reads this flag. Set it to `yes` if this repo handles external PRs as feature requests. When the flag is `yes`, PRs use the same labels and states as issues, with the `gh pr` commands:

- **Read a PR**: `gh pr view <number> --comments`. Run `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`. Keep only an `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`. Remove `OWNER`, `MEMBER` and `COLLABORATOR`.
- **Comment, label or close**: `gh pr comment`, `gh pr edit --add-label` or `--remove-label`, `gh pr close`.

Issues and PRs on GitHub use the same set of numbers, so `#42` can be an issue or a PR. Run `gh pr view 42` first. If that fails, run `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `/wayfinder` skill uses these operations. The map is one issue. Its tickets are child issues.

- **Map**: one issue with the label `wayfinder:map`. Its body has the Notes, the Decisions so far and the fog. Create it with `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue that is a GitHub sub-issue of the map. Link it with `gh api` on the sub-issues endpoint. If the repo does not have sub-issues, add the child to a task list in the map body. Then put `Part of #<map>` at the top of the child body. The label is `wayfinder:<type>`, where the type is `research`, `prototype`, `grilling` or `task`. A claimed ticket has the dev who drives the map as its assignee.
- **Blocking**: use the issue dependencies that GitHub has. They are the standard record, and the GitHub UI shows them. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. The `<blocker-db-id>` is the numeric database id of the blocker. It is not the `#number` or the `node_id`. Get it with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. GitHub reports `issue_dependencies_summary.blocked_by`, which counts only the open blockers. If the repo does not have dependencies, put a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket has no block when each of its blockers has the closed state.
- **Frontier query**: list the open children of the map with `gh issue list --state open`. Keep only the sub-issues or the task list items of the map. Remove each child that has an open blocker or an assignee. A child has an open blocker when `issue_dependencies_summary.blocked_by > 0` or when its `Blocked by` line has an open issue. Take the first child in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me`. This is the first write of the session.
- **Resolve**: run `gh issue comment <n> --body "<answer>"` and then `gh issue close <n>`. Then add a context pointer to the Decisions so far of the map. A context pointer is a short summary and a link.
