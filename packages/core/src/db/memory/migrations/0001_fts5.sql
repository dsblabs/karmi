CREATE VIRTUAL TABLE `notes` USING fts5(text, agent_id UNINDEXED, created_at UNINDEXED);
