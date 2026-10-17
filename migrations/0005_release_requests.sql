-- Taking a car back from a customer becomes a request somebody has to approve, and the retail
-- export becomes a third thing the dealership can load.
--
-- Two CHECK constraints have to widen, and SQLite cannot alter a CHECK, so both tables are
-- rebuilt. MANUAL_ALLOCATION stays in the exceptions list even though nothing writes it any
-- more: the rows that already carry it are the record of allocations made by hand, and that
-- record is the reason the type is being retired rather than a reason to erase it.

-- Allocation changes now have a reason drawn from a fixed list rather than whatever the calling
-- code passed, and a release that came from an approved request points back at it. The column
-- itself stays free text: every release ever written has to remain readable, including the
-- thirteen tokens in use before this migration.
ALTER TABLE allocations ADD COLUMN release_request_id TEXT;

-- The target of a reallocation, when the request named one. Held on the allocation that ends so
-- that the chain reads forwards: this car left this booking, and here is the booking it went to.
ALTER TABLE allocations ADD COLUMN released_to_booking_id TEXT;

CREATE INDEX idx_alloc_release_request ON allocations (tenant_id, release_request_id);

-- ---------------------------------------------------------------------------------------------
-- exceptions: + RELEASE_ALLOCATION
-- ---------------------------------------------------------------------------------------------
CREATE TABLE exceptions_new (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  type             TEXT NOT NULL CHECK (type IN
                     ('PRIORITY_CHANGE','SKIP_ALLOCATION','DEFER_DELIVERY','OUTLET_CHANGE','MANUAL_ALLOCATION','WINDOW_EXTENSION','RELEASE_ALLOCATION','OTHER')),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  vehicle_id       TEXT REFERENCES vehicles(id),
  payload_json     TEXT NOT NULL DEFAULT '{}',
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  requested_by     TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  decided_by       TEXT,
  decided_at       TEXT,
  decision_remarks TEXT
);

INSERT INTO exceptions_new
  (id, tenant_id, type, booking_id, vehicle_id, payload_json, reason, status,
   requested_by, requested_at, decided_by, decided_at, decision_remarks)
SELECT
   id, tenant_id, type, booking_id, vehicle_id, payload_json, reason, status,
   requested_by, requested_at, decided_by, decided_at, decision_remarks
FROM exceptions;

DROP TABLE exceptions;
ALTER TABLE exceptions_new RENAME TO exceptions;
CREATE INDEX idx_exceptions ON exceptions (tenant_id, status);

-- ---------------------------------------------------------------------------------------------
-- uploads: + RETAIL
-- ---------------------------------------------------------------------------------------------
CREATE TABLE uploads_new (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL CHECK (kind IN ('STOCK','BOOKINGS','RETAIL')),
  mode          TEXT NOT NULL DEFAULT 'UPDATE',
  report_date   TEXT,
  summary_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'DONE',
  filename      TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT NOT NULL DEFAULT '[]',
  outlets_json  TEXT NOT NULL DEFAULT '[]',
  uploaded_by   TEXT NOT NULL,
  at            TEXT NOT NULL
);

INSERT INTO uploads_new
  (id, tenant_id, kind, mode, report_date, summary_json, status, filename, row_count,
   created_count, updated_count, unchanged_count, error_count, errors_json, outlets_json,
   uploaded_by, at)
SELECT
   id, tenant_id, kind, mode, report_date, summary_json, status, filename, row_count,
   created_count, updated_count, unchanged_count, error_count, errors_json, outlets_json,
   uploaded_by, at
FROM uploads;

DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;
CREATE INDEX idx_uploads ON uploads (tenant_id, kind, at);
