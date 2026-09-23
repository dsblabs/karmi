---
"@karmi/core": minor
---

Added the Playground scenario "Knowledge ingestion and document search". The scenario shows these parts of Knowledge:

- A librarian Agent searches a handbook corpus with the `search_handbook` Tool. A card runs the same search with `scope.knowledge("handbook").search` and shows the Passages with their `docId`, `score` and metadata next to the answer of the Agent.
- A notices corpus is in the Prompt of the Agent with `mode: "inline"`. The Agent answers from it without a Tool call. A corpus over the inline limit fails the Turn, and the card shows the error.
- Ingest and update documents from a form. A bulk ingest of 40 documents returns a pending Job. The card shows its progress, and a search finds each committed document.
- Delete a document or destroy a corpus. Reset destroys each corpus and ingests the starting documents again. A reset during a pending bulk ingest gets a `knowledge.busy` answer and changes nothing.
