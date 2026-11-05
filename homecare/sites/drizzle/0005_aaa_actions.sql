CREATE TABLE IF NOT EXISTS aaa_actions (
  source TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  owner TEXT NOT NULL,
  due TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','complete')),
  version INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_actions_branch_due ON aaa_actions(branch,status,due);
