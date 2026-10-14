-- Day-wise stock position per outlet: the position at the end of each DMS file load and at the day-end
-- reconciliation, under the dealership's business date, so any past day can be shown without re-reading files.
CREATE TABLE stock_positions (
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  date                 TEXT NOT NULL,                     -- the dealership's business date
  outlet_id            TEXT NOT NULL REFERENCES outlets(id),
  in_transit_free      INTEGER NOT NULL DEFAULT 0,
  in_transit_reserved  INTEGER NOT NULL DEFAULT 0,
  in_yard_free         INTEGER NOT NULL DEFAULT 0,
  in_yard_reserved     INTEGER NOT NULL DEFAULT 0,
  invoiced_in_stock    INTEGER NOT NULL DEFAULT 0,        -- retail-invoiced, not yet taken away
  blocked              INTEGER NOT NULL DEFAULT 0,        -- blocked or demo cars, counted apart
  value_unsold         REAL,                              -- dealer value of free cars (NULL when no price is known)
  source               TEXT NOT NULL CHECK (source IN ('STOCK_REPORT','BOOKING_SHEET','DAY_END')),
  recorded_at          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, date, outlet_id)
);
