CREATE TABLE IF NOT EXISTS aaa_calendar (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  author TEXT NOT NULL,
  branch TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  reminder_at TEXT,
  audience TEXT NOT NULL CHECK(audience IN ('private','branch')),
  carer_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('scheduled','completed','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_calendar_branch_start ON aaa_calendar(branch,start_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_calendar_owner ON aaa_calendar(owner_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS aaa_calendar_history (
  event_id TEXT NOT NULL REFERENCES aaa_calendar(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  reminder_at TEXT,
  audience TEXT NOT NULL,
  carer_summary TEXT NOT NULL,
  notes TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id,version)
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS aaa_calendar_record_revision AFTER UPDATE ON aaa_calendar BEGIN
  INSERT INTO aaa_calendar_history VALUES (OLD.id,OLD.version,OLD.status,OLD.title,OLD.kind,OLD.start_at,OLD.end_at,OLD.reminder_at,OLD.audience,OLD.carer_summary,OLD.notes,OLD.updated_by,OLD.updated_at);
END;
