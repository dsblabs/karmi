---
"@karmi/core": minor
---

Added the Playground scenario "Child Threads and their Approvals". The scenario shows these parts of a Delegation:

- The `delegate` Tool starts a child Thread, and the parent Turn parks until the child answers.
- The child in its own card of the conversation, with its task, its Tool calls and its answer.
- The Approval of a child in the parent Thread, with allow and deny outcomes.
- The cancel of the parent Turn, which stops each child. Reset deletes each child Thread.
- The Usage records of the parent and of each child, with the parent link on the records of a child.
