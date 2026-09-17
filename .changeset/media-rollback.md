---
"@karmi/core": patch
"@karmi/http": patch
---

Discard media uploaded for a multipart Turn that is never accepted. `thread.uploads` gains `delete(ref)`, which removes an object the Thread minted and is a no-op for a ref another Thread minted, and the HTTP turns route now discards every ref it uploaded when the multipart parse or `send()` throws, without replacing the error the caller receives.
