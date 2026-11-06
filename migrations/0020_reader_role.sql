-- A new role: the Reader, who sees every screen and changes nothing but their own password.
--
-- The role is a CHECK constraint and SQLite cannot alter one, so the users table is rebuilt the way
-- 0006 and 0010 do it: rows to a holding table, the table dropped and created again under its own name,
-- rows back, every column as it stands now (left_on from 0016, welcomed_at from 0017). Nothing else
-- changes: no row's role or any other value is touched.

PRAGMA defer_foreign_keys = true;

CREATE TABLE users_tmp AS SELECT * FROM users;

DROP TABLE users;

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  name                 TEXT NOT NULL,
  mobile               TEXT NOT NULL,
  email                TEXT,
  role                 TEXT NOT NULL CHECK (role IN
                         ('ADMIN','DEALER_PRINCIPAL','CEO_VP','GM_SALES','AGM_SALES','SALES_LEAD','SALES_CONSULTANT','EDP_MANAGER','FINANCE','AUDITOR','READER')),
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  token_version        INTEGER NOT NULL DEFAULT 0,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  all_outlets          INTEGER NOT NULL DEFAULT 0,   -- 1 = sees every outlet of the tenant
  dms_code             TEXT,                         -- the person's ID in the DMS (SC Mile Id)
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  left_on              TEXT,
  welcomed_at          TEXT,
  UNIQUE (tenant_id, mobile)
);

INSERT INTO users
  (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, token_version,
   failed_logins, locked_until, all_outlets, dms_code, is_active, created_at, left_on, welcomed_at)
SELECT
   id, tenant_id, name, mobile, email, role, password_hash, must_change_password, token_version,
   failed_logins, locked_until, all_outlets, dms_code, is_active, created_at, left_on, welcomed_at
FROM users_tmp;

DROP TABLE users_tmp;
