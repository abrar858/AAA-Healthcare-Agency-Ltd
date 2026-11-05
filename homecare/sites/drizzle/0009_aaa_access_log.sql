CREATE TABLE IF NOT EXISTS aaa_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  branch TEXT,
  target_id TEXT
);
