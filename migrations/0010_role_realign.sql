-- The roles realigned to the ones a dealership actually uses: System Admin, Dealer Principal, CEO / VP,
-- GM Sales, AGM Sales, Sales Lead, Sales Consultant, EDP Manager, Finance, Auditor.
--
-- Who does what changes with them. The AGM raises an allocation or deallocation request; the GM and the
-- CEO / VP decide it; Finance alone acts on money; the EDP Manager alone loads the DMS files. The old
-- Business Head and Vice President become one CEO / VP; CRM, Stock In-charge and Ordering Desk become
-- the EDP Manager; Sales Manager becomes Sales Lead and Sales Executive becomes Sales Consultant.
--
-- The role is a CHECK constraint and SQLite cannot alter one, so the users table is rebuilt the way
-- 0006 does it: rows to a holding table, the table dropped and created again under its own name, rows
-- back. Renaming a differently-named table into place leaves a deferred foreign-key violation that
-- fails at COMMIT, because user_outlets, user_segments, password_otps and bookings all point here.

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
                         ('ADMIN','DEALER_PRINCIPAL','CEO_VP','GM_SALES','AGM_SALES','SALES_LEAD','SALES_CONSULTANT','EDP_MANAGER','FINANCE','AUDITOR')),
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
   id, tenant_id, name, mobile, email,
   CASE role
     WHEN 'BUSINESS_HEAD'  THEN 'CEO_VP'
     WHEN 'VP'             THEN 'CEO_VP'
     WHEN 'SALES_MANAGER'  THEN 'SALES_LEAD'
     WHEN 'SALES_EXEC'     THEN 'SALES_CONSULTANT'
     WHEN 'ACCOUNTS'       THEN 'FINANCE'
     WHEN 'CRM'            THEN 'EDP_MANAGER'
     WHEN 'STOCK_INCHARGE' THEN 'EDP_MANAGER'
     WHEN 'ORDERING'       THEN 'EDP_MANAGER'
     ELSE role
   END,
   password_hash, must_change_password, token_version,
   failed_logins, locked_until, all_outlets, dms_code, is_active, created_at
FROM users_tmp;

DROP TABLE users_tmp;

-- The dealership's own lists of approvers and alarm recipients name roles, so they move with them.
-- settings_json is written by JSON.stringify, so the names appear as compact quoted tokens. Merging
-- Business Head and Vice President into one role can leave the same name twice in a list; the last two
-- statements take the repeat out. A repeat would do no harm, but a list shown on screen should read right.
UPDATE tenants SET settings_json = replace(replace(replace(replace(replace(replace(replace(replace(
  settings_json,
  '"BUSINESS_HEAD"', '"CEO_VP"'), '"VP"', '"CEO_VP"'),
  '"SALES_MANAGER"', '"SALES_LEAD"'), '"SALES_EXEC"', '"SALES_CONSULTANT"'),
  '"ACCOUNTS"', '"FINANCE"'), '"CRM"', '"EDP_MANAGER"'),
  '"STOCK_INCHARGE"', '"EDP_MANAGER"'), '"ORDERING"', '"EDP_MANAGER"')
WHERE json_valid(settings_json);

UPDATE tenants SET settings_json = replace(settings_json, '"CEO_VP","CEO_VP"', '"CEO_VP"') WHERE json_valid(settings_json);
UPDATE tenants SET settings_json = replace(settings_json, '"EDP_MANAGER","EDP_MANAGER"', '"EDP_MANAGER"') WHERE json_valid(settings_json);
