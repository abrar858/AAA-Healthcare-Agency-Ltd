CREATE TABLE aaa_staff_access_new (
  email TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','team_leader','hr','rota','accounts','carer')),
  branch TEXT NOT NULL,
  staff TEXT,
  identity_id TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  CHECK ((role = 'carer') = (staff IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO aaa_staff_access_new SELECT email,label,role,branch,staff,identity_id,enabled,version,updated_at FROM aaa_staff_access;
--> statement-breakpoint
DROP TABLE aaa_staff_access;
--> statement-breakpoint
ALTER TABLE aaa_staff_access_new RENAME TO aaa_staff_access;
--> statement-breakpoint
CREATE UNIQUE INDEX aaa_one_active_login_per_carer ON aaa_staff_access (staff) WHERE staff IS NOT NULL AND enabled = 1;
