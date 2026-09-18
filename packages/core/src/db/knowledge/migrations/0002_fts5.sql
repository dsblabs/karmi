CREATE VIRTUAL TABLE `chunks_fts` USING fts5(text, content='chunks', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER `chunks_insert` AFTER INSERT ON `chunks` BEGIN
  INSERT INTO `chunks_fts`(rowid, text) VALUES (new.id, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER `chunks_delete` AFTER DELETE ON `chunks` BEGIN
  INSERT INTO `chunks_fts`(`chunks_fts`, rowid, text) VALUES ('delete', old.id, old.text);
END;
