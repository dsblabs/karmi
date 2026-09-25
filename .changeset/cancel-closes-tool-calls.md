---
"@karmi/core": patch
---

Fixed the log of a cancelled Turn. It left a Tool call without a result when the call ran at the cancel.

- Each Tool call that runs at the cancel now gets an interrupted result, the same result as after an eviction. A Tool call that a Script makes also gets one.
- The model now sees the results of the cancelled tool Step in the next Turn. Before, it got "No result provided" for each call, also for a call that finished.
- An eviction during a Script now gives an interrupted result to each nested call that did not finish.
- The Playground shows a nested call that a cancel interrupted as "interrupted, may have taken effect". Before, it showed "running".
