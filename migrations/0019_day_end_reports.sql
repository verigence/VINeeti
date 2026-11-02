-- The day-end report: one row per dealership and business day, so the scheduled job sends each day's
-- report once, retries a failed send a few times, and the settings screen can say what went out.
CREATE TABLE day_end_reports (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  business_date   TEXT NOT NULL,
  status          TEXT NOT NULL,          -- SENT, PARTLY_SENT, FAILED, NO_RECIPIENTS, MAIL_NOT_CONFIGURED
  attempts        INTEGER NOT NULL DEFAULT 1,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  sent_at         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (tenant_id, business_date)
);
