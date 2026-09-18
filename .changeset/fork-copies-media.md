---
"@karmi/core": patch
---

`thread.fork(seq)` now copies every object the forked log refers to, uploaded media and spilled Tool output alike, into the Fork's own prefixes and rewrites the refs to match, so a Fork keeps its media after the original Thread is deleted. The fork resolves only once every copy has landed; if a copy fails it rejects and the half-made Fork cleans itself up. Media reads are now limited to a Thread's own objects and those of its delegation tree, so a Fork made before this change loses the media it still reads from its original.
