CREATE TABLE aaa_workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO aaa_workspace (id, body) VALUES (1, '{"branches":[],"patches":[],"clients":[],"staff":[],"visits":[],"requests":[],"audit":[],"compliance":[]}');
