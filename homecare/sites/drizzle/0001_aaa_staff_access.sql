CREATE TABLE aaa_staff_access (
  email TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','hr','rota','accounts','carer')),
  branch TEXT NOT NULL,
  staff TEXT,
  identity_id TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  CHECK ((role = 'carer') = (staff IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX aaa_one_active_login_per_carer ON aaa_staff_access (staff) WHERE staff IS NOT NULL AND enabled = 1;
