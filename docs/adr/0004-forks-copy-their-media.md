# 4. A Fork copies the media its log refers to

Date: 2026-09-18. Status: accepted. Decided in [Deleting a parent Thread silently destroys its Forks' media](https://github.com/dsblabs/karmi/issues/107).

## Context

A Fork used to copy event rows only. Its `MediaRef`s kept pointing at objects under the original Thread's prefix, so deleting the original Thread turned the Fork's images, files and spilled tool output into placeholders without any error. The harnesses karmi baselines against (Claude Code, Codex, pi) keep media bytes inside the transcript, so their forks are independent by construction, and a developer arriving from them expects a Fork to survive its original.

## Decision

`thread.fork(seq)` copies every object referenced by the log at or before `seq`, spilled tool output included, into the Fork's own prefixes and rewrites the keys in the seeded rows. It resolves only when every copy has landed and fails as a whole otherwise; an object already missing in the original is skipped, because it is already a placeholder there. Media reads are validated at Thread granularity, since no Thread holds another Thread's key any more.

## Considered options

- **A mapping from Threads to shared objects, deleting an object when its last mapping goes.** Fork would stay O(rows) and store nothing twice. Rejected because the mapping must outlive every Thread, which puts one Scope Durable Object on the path of every mint, spill and Thread delete; because R2 and the mapping cannot change atomically, so a crash leaks objects that no prefix walk can find; and because deleting a Thread would no longer mean its bytes are gone.
- **Keeping the original's media alive while Forks exist, or copying on the original's deletion.** Both need the Fork tree that karmi deliberately does not keep, and both make deletion slow or not final.
- **Documenting the loss.** Rejected as a bad experience.

## Consequences

- Fork latency and R2 writes grow with the bytes referenced, and forked media is stored twice. Fork is a rare, deliberate act, and R2 storage is cheap enough that this is the right place to pay.
- If fork latency becomes a problem, the S3 credentials already used for presigned URLs allow a server-side `CopyObject`, which moves no bytes through the Durable Object.
- "A `MediaRef` lives and dies with its Thread" holds with no exception, and Thread cleanup stays a walk over the Thread's own prefixes.
- A Fork created before this change still carries its original's keys and loses that media once reads are Thread-scoped.
