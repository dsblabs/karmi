---
"@karmi/core": patch
---

Fixed the Playground page. After a reset of the Schedules scenario, a timer of its WebSocket could close the stream of the scenario that the operator opened next. That scenario then showed no new event. The timer now runs only while its socket is the stream of the page and the operator is in the same view.
