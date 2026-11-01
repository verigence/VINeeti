-- Tickets raised by the people who use the system, read by the platform administrator. A ticket belongs
-- to the dealership it was raised at, so one dealership never sees another's, while the platform console
-- sees them all: the point of it is that somebody outside the dealership answers them.
--
-- The attachment itself lives in object storage, not here; this holds only what is needed to find it and
-- to show the person what they sent (its key, the name they gave it, its type and size).
CREATE TABLE support_tickets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  raised_by       TEXT NOT NULL REFERENCES users(id),
  raiser_name     TEXT NOT NULL,              -- kept as written, so a renamed or removed user still reads properly
  raiser_role     TEXT NOT NULL,
  raiser_email    TEXT,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- OPEN until somebody outside the dealership has dealt with it; CLOSED when they have.
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  attachment_key  TEXT,                       -- where the file sits in the bucket
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  emailed         INTEGER NOT NULL DEFAULT 0, -- whether support was told; a failure is visible rather than silent
  email_error     TEXT,
  created_at      TEXT NOT NULL,
  closed_at       TEXT,
  closed_by       TEXT,
  closing_note    TEXT
);
CREATE INDEX idx_tickets_tenant ON support_tickets (tenant_id, created_at);
CREATE INDEX idx_tickets_status ON support_tickets (status, created_at);
CREATE INDEX idx_tickets_raiser ON support_tickets (raised_by, created_at);
