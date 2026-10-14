-- The platform's own administrators ("super admin"): the people who run the deployment itself.
-- They are not users of any dealership and can see no dealership's customers, bookings or stock; what
-- they can do is create a dealership, switch one off, and give a dealership's first administrator a new
-- temporary password. Every one of those acts is written to platform_audit.
CREATE TABLE platform_admins (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  mobile               TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  token_version        INTEGER NOT NULL DEFAULT 0,   -- bumping it signs the account out everywhere
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE platform_audit (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,                         -- a platform admin's id, or DEPLOY for the pipeline
  action      TEXT NOT NULL,
  entity      TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL
);
CREATE INDEX idx_platform_audit_at ON platform_audit (at DESC);

-- Append-only, like the dealership's own audit trail.
CREATE TRIGGER platform_audit_no_update BEFORE UPDATE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'platform_audit is append-only'); END;
CREATE TRIGGER platform_audit_no_delete BEFORE DELETE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'platform_audit is append-only'); END;
