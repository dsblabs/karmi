---
"@karmi/core": patch
---

`KarmiError.code` is now the exported `KarmiErrorCode` union instead of `string`, so a caller can switch on it exhaustively.
