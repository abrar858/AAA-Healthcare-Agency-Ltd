CREATE TABLE IF NOT EXISTS aaa_diary (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('client','carer')),
  subject TEXT NOT NULL,
  branch TEXT NOT NULL,
  person TEXT NOT NULL,
  category TEXT NOT NULL,
  occurred_date TEXT NOT NULL,
  occurred_time TEXT,
  note TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  related TEXT REFERENCES aaa_diary(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_diary_subject_date ON aaa_diary(type, branch, subject, occurred_date DESC, occurred_time DESC, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_diary_date ON aaa_diary(type, occurred_date DESC, occurred_time DESC, created_at DESC);
