---
"@karmi/core": minor
---

Added the Playground scenario "User Memory and Scope isolation". The scenario shows these parts of Memory and of Scopes:

- The `remember` Tool writes a Profile field and a Note. A card shows the Memory that `scope.users.memory` reads.
- A new Thread of the same User gets the Memory Fragment and answers without a Tool call. The `recall` Tool finds a Note.
- Forget deletes the Memory, and the next Thread does not know the preference.
- The same User in a second sample Scope has an empty Memory, and a Thread key of one Scope gets a 404 answer through the other. The access token selects the sample Scope with a `scope` query parameter.
