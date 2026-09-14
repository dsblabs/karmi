---
"@karmi/core": patch
---

Scheduling: `thread.schedule({ at | delay | cron, tz?, input })`, `cancelSchedule` and `schedules()` fire an Event into the Thread from its own alarm, coalescing while a Turn runs or is parked and holding at most one undelivered cron firing; `schedule.created / fired / skipped / cancelled` events and `status().nextScheduleAt`; the `scheduling { maxPending, maxHorizonMs, cron }` Capability grants the Agent `schedule`, `cancel_schedule` and `list_schedules` for its own Thread.
