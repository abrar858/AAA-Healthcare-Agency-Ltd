ALTER TABLE aaa_calendar ADD COLUMN subject_type TEXT CHECK(subject_type IN ('client','carer'));
--> statement-breakpoint
ALTER TABLE aaa_calendar ADD COLUMN subject_id TEXT;
--> statement-breakpoint
ALTER TABLE aaa_calendar_history ADD COLUMN subject_type TEXT;
--> statement-breakpoint
ALTER TABLE aaa_calendar_history ADD COLUMN subject_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aaa_calendar_person_date ON aaa_calendar(branch,subject_type,subject_id,start_at);
--> statement-breakpoint
DROP TRIGGER aaa_calendar_record_revision;
--> statement-breakpoint
CREATE TRIGGER aaa_calendar_record_revision AFTER UPDATE ON aaa_calendar BEGIN
  INSERT INTO aaa_calendar_history VALUES (OLD.id,OLD.version,OLD.status,OLD.title,OLD.kind,OLD.start_at,OLD.end_at,OLD.reminder_at,OLD.audience,OLD.carer_summary,OLD.notes,OLD.updated_by,OLD.updated_at,OLD.subject_type,OLD.subject_id);
END;
