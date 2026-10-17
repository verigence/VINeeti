-- A Vice President: the person who decides whether a car may be taken back from the customer
-- holding it. Allocation by hand is closed, so that decision is the only way a named car reaches a
-- named booking, and it answers to someone above the day's running.
--
-- Adding the role means widening a CHECK constraint, and SQLite cannot alter one, so the users table
-- has to be rebuilt. Unlike the two tables rebuilt in 0005, this one is a parent: user_outlets,
-- password_otps and bookings.sales_exec_id all point at it, and foreign keys are enforced.
--
-- The usual rebuild — build beside it, drop, rename into place — does not survive here. Dropping a
-- referenced parent records a deferred violation, and renaming a differently-named table into its
-- place does not clear it, so the transaction fails at COMMIT even though the data is sound
-- (PRAGMA foreign_key_check reports nothing either way). Taking foreign keys off instead is no help:
-- D1 runs a migration inside a transaction, and that pragma is a no-op within one.
--
-- So the table is put back under its own name rather than renamed into place. The rows go to a
-- holding table, the real one is dropped and created again as itself, and by the time the
-- transaction commits `users` exists with every row it started with, which is what the deferred
-- check is looking for.

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
                         ('ADMIN','DEALER_PRINCIPAL','BUSINESS_HEAD','VP','SALES_MANAGER','SALES_EXEC','ACCOUNTS','CRM','STOCK_INCHARGE','ORDERING','AUDITOR')),
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  token_version        INTEGER NOT NULL DEFAULT 0,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  all_outlets          INTEGER NOT NULL DEFAULT 0,   -- 1 = sees every outlet of the tenant
  dms_code             TEXT,                         -- the person's ID in the DMS (SC Mile Id)
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  UNIQUE (tenant_id, mobile)
);

INSERT INTO users
  (id, tenant_id, name, mobile, email, role, password_hash, must_change_password, token_version,
   failed_logins, locked_until, all_outlets, dms_code, is_active, created_at)
SELECT
   id, tenant_id, name, mobile, email, role, password_hash, must_change_password, token_version,
   failed_logins, locked_until, all_outlets, dms_code, is_active, created_at
FROM users_tmp;

DROP TABLE users_tmp;
