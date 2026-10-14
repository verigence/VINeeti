-- Verigence VINeeti: initial schema.
-- Every business table carries tenant_id. A tenant is one dealership + OEM (for example a Mahindra dealership).
-- Outlets live inside a tenant. All timestamps are ISO-8601 UTC text; dates are YYYY-MM-DD.

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,          -- dealer code used at login and in URLs
  name          TEXT NOT NULL,
  oem           TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  settings_json TEXT NOT NULL DEFAULT '{}',
  is_active     INTEGER NOT NULL DEFAULT 1,
  eod_key_hash  TEXT,                          -- the end-of-day feed key (only its hash), for a scheduled job that sends the DMS files
  eod_key_set_at TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE outlets (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  city       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  name                 TEXT NOT NULL,
  mobile               TEXT NOT NULL,
  email                TEXT,
  role                 TEXT NOT NULL CHECK (role IN
                         ('ADMIN','DEALER_PRINCIPAL','BUSINESS_HEAD','SALES_MANAGER','SALES_EXEC','ACCOUNTS','CRM','STOCK_INCHARGE','ORDERING','AUDITOR')),
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  token_version        INTEGER NOT NULL DEFAULT 0,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  all_outlets          INTEGER NOT NULL DEFAULT 0,   -- 1 = sees every outlet of the tenant
  dms_code             TEXT,                         -- the person's ID in the DMS (SC Mile Id), so bookings in the sheet reach their sales executive
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  UNIQUE (tenant_id, mobile)
);

-- One-time codes for setting a password, sent to the user's own mobile number on WhatsApp. Only the hash of a code is kept.
CREATE TABLE password_otps (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_password_otps ON password_otps (tenant_id, user_id, created_at);

CREATE TABLE user_outlets (
  user_id   TEXT NOT NULL REFERENCES users(id),
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, outlet_id)
);

-- ---------------------------------------------------------------- vehicle master
-- The manufacturer's product list as this dealership sells it. For Mahindra a car is identified by
-- category, model, trim, transmission, fuel, drive, seater and variant. The variant name is the key:
-- stock, bookings and orders all carry it, so a car and a booking match only when they name the same
-- master variant (and colour). Variants are registered from the DMS files as they appear: the name is the
-- OEM variant with its OEM model code, "AX5 PM MT (M1024)", read by the description parser.
CREATE TABLE vehicle_variants (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  category     TEXT NOT NULL,              -- e.g. Passenger, Commercial, EV
  model        TEXT NOT NULL,              -- stored in capitals with single spaces, like every model in the system
  trim_level   TEXT NOT NULL DEFAULT '',
  transmission TEXT NOT NULL DEFAULT '',
  fuel         TEXT NOT NULL DEFAULT '',
  drive        TEXT NOT NULL DEFAULT '',
  seater       TEXT NOT NULL DEFAULT '',
  variant      TEXT NOT NULL,              -- in capitals with single spaces: exactly what stock and bookings carry
  variant_key  TEXT NOT NULL,              -- letters and digits only, so spacing and punctuation never cause a mismatch
  oem_model_code TEXT NOT NULL DEFAULT '', -- the manufacturer's model code (Mxxxx) carried by the stock report and the booking sheet
  origin       TEXT NOT NULL DEFAULT 'MANUAL', -- DMS = registered from a stock report or booking sheet
  fuel_source  TEXT,                       -- where the fuel came from when the description does not state it
  is_active    INTEGER NOT NULL DEFAULT 1, -- a discontinued variant stays for existing stock and bookings but takes no new bookings
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (tenant_id, variant_key)
);
CREATE INDEX idx_variants_model ON vehicle_variants (tenant_id, model);

-- Colours offered for each model. A model with no colours listed accepts any colour name.
CREATE TABLE vehicle_colours (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  model      TEXT NOT NULL,
  colour     TEXT NOT NULL,
  colour_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, model, colour_key)
);

-- Paint codes seen in stock reports: for a model, the OEM colour code and the paint alias in the
-- description ("WQ") with the colour name cars of that paint carry. A booking's description ends with
-- the same alias, which is how its colour is known even where the two reports name the colour differently.
CREATE TABLE vehicle_paints (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  model           TEXT NOT NULL,
  oem_colour_code TEXT NOT NULL,
  paint_alias     TEXT NOT NULL DEFAULT '',
  colour          TEXT NOT NULL,
  dms_colour      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, model, oem_colour_code, paint_alias)
);

-- Names used in DMS exports that differ from the master. A row with no target is a name that was seen
-- in an upload and still has to be mapped by the administrator; once mapped, every later file resolves it.
CREATE TABLE vehicle_aliases (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  kind         TEXT NOT NULL CHECK (kind IN ('VARIANT','COLOUR')),
  alias        TEXT NOT NULL,               -- as it appeared in the file
  alias_key    TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',    -- for a colour: the model it belongs to
  variant_id   TEXT REFERENCES vehicle_variants(id),
  colour       TEXT,
  seen_count   INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  mapped_by    TEXT,
  mapped_at    TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (tenant_id, kind, model, alias_key)
);

-- ---------------------------------------------------------------- stock
CREATE TABLE vehicles (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  outlet_id              TEXT NOT NULL REFERENCES outlets(id),
  vin                    TEXT NOT NULL,
  engine_no              TEXT,
  variant_id             TEXT REFERENCES vehicle_variants(id),  -- the master variant; model and variant below are its names
  model                  TEXT NOT NULL,
  variant                TEXT NOT NULL,
  colour                 TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('IN_TRANSIT','RECEIVED','INVOICED','DELIVERED','REMOVED')),
  is_blocked             INTEGER NOT NULL DEFAULT 0,   -- damage / inspection hold: not allocatable
  block_reason           TEXT,
  wholesale_invoice_no   TEXT,
  wholesale_invoice_date TEXT,
  dispatch_date          TEXT,
  expected_arrival_date  TEXT,
  received_at            TEXT,
  invoiced_at            TEXT,
  delivered_at           TEXT,
  dms_booking_no         TEXT,                          -- the DMS order (Order ID) this car is allotted or billed to
  ever_allocated         INTEGER NOT NULL DEFAULT 0,
  -- As the DMS stock report gives it. The colour above is the name bookings are matched by; these keep the source.
  description            TEXT,                          -- Model Description, e.g. "XUV3XO AX5 PM MT WQ(A3EVRSTWHT)(M1024)"
  oem_model_code         TEXT,
  oem_colour_code        TEXT,
  paint_alias            TEXT NOT NULL DEFAULT '',
  dms_colour             TEXT,
  seating                TEXT,
  is_demo                INTEGER NOT NULL DEFAULT 0,    -- demo cars are never allocated
  net_dealer_price       REAL,
  grn_no                 TEXT,
  dms_stock_type         TEXT,                          -- UNALLOTED, ALLOTED or IBND in the latest report that listed the car
  dms_order_date         TEXT,
  dms_customer_name      TEXT,
  dms_sc_name            TEXT,
  dms_allotment_id       TEXT,
  dms_allotment_date     TEXT,
  dms_invoice_id         TEXT,
  dms_invoice_date       TEXT,
  dms_issues_json        TEXT NOT NULL DEFAULT '[]',    -- data points in the report row that disagree with each other
  report_date            TEXT,                          -- date of the latest stock report that listed the car
  left_stock_on          TEXT,                          -- date of the first stock report that no longer listed it
  source                 TEXT NOT NULL DEFAULT 'MANUAL',
  last_upload_id         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (tenant_id, vin)
);
CREATE INDEX idx_vehicles_config ON vehicles (tenant_id, model, variant, colour, status);
CREATE INDEX idx_vehicles_outlet ON vehicles (tenant_id, outlet_id, status);

CREATE TABLE vehicle_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id),
  type        TEXT NOT NULL,       -- CREATED, RECEIVED, INVOICED, DELIVERED, TRANSFERRED, BLOCKED, UNBLOCKED, ETA_CHANGED, REMOVED, UPDATED
  from_status TEXT,
  to_status   TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor       TEXT NOT NULL,       -- user id, 'SYSTEM' or 'UPLOAD:<id>'
  at          TEXT NOT NULL
);
CREATE INDEX idx_vehicle_events ON vehicle_events (tenant_id, vehicle_id, at);
CREATE INDEX idx_vehicle_events_day ON vehicle_events (tenant_id, at);

-- ---------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  outlet_id              TEXT NOT NULL REFERENCES outlets(id),
  booking_no             TEXT NOT NULL,
  customer_name          TEXT NOT NULL,
  customer_mobile        TEXT NOT NULL,
  wa_opt_in              INTEGER NOT NULL DEFAULT 1,
  variant_id             TEXT REFERENCES vehicle_variants(id),
  model                  TEXT NOT NULL,
  variant                TEXT NOT NULL,
  colour                 TEXT NOT NULL,
  booking_date           TEXT NOT NULL,     -- when the customer booked
  priority_ts            TEXT NOT NULL,     -- effective queue date (booking_date unless an approved exception changed it)
  priority_override_json TEXT,              -- set by an approved "move ahead of booking X": the values it queues with instead of its own
  booking_amount         REAL NOT NULL DEFAULT 0,
  expected_delivery_date TEXT,
  status                 TEXT NOT NULL CHECK (status IN
                           ('DRAFT','SUBMITTED','APPROVED','REJECTED','ALLOCATED','INVOICED','DELIVERED','CANCELLED')),
  on_hold                INTEGER NOT NULL DEFAULT 0,
  hold_reason            TEXT,
  hold_until             TEXT,
  -- Payment for the allocated car. Sales reports it; Finance verifies it. Only verification (payment_received_at) stops the payment window.
  payment_reported_at    TEXT,
  payment_reported_by    TEXT,
  payment_amount         REAL,
  payment_ref            TEXT,                          -- UTR / receipt / cheque number as reported
  payment_note           TEXT,
  payment_received_at    TEXT,                          -- when Finance verified the payment as received
  payment_verified_by    TEXT,
  payment_overdue_alarm_at TEXT,                        -- when the "reported but not verified" alarm was raised
  invoiced_at            TEXT,
  delivered_at           TEXT,
  sales_exec_id          TEXT REFERENCES users(id),
  submitted_at           TEXT,
  approved_by            TEXT,
  approved_at            TEXT,
  decision_remarks       TEXT,
  cancelled_at           TEXT,
  cancel_reason          TEXT,
  source                 TEXT NOT NULL DEFAULT 'APP',   -- APP, DMS (booking sheet) or DMS_STOCK (known only from a stock report's Order ID)
  -- Booking submission checklist (step 3): which documents the person submitting confirms are on file. No copies are stored.
  checklist_json         TEXT NOT NULL DEFAULT '{}',
  -- As the DMS booking sheet gives it.
  description            TEXT,                          -- Model Description, e.g. "XUV3XO AX5 PM MT WQ"
  oem_model_code         TEXT,
  paint_alias            TEXT NOT NULL DEFAULT '',
  dms_colour             TEXT,
  seating                TEXT,
  dms_stage              TEXT,                          -- Booking Stage in the latest sheet that listed the booking
  dms_enquiry_stage      TEXT,
  dms_ref                TEXT,                          -- the dealer-side Booking Number (B-...)
  enquiry_no             TEXT,
  sc_name                TEXT,
  sc_code                TEXT,
  sm_name                TEXT,
  sheet_date             TEXT,                          -- date of the latest booking sheet that listed the booking
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (tenant_id, booking_no)
);
CREATE INDEX idx_bookings_queue ON bookings (tenant_id, model, variant, colour, status, priority_ts);
CREATE INDEX idx_bookings_outlet ON bookings (tenant_id, outlet_id, status);

-- ---------------------------------------------------------------- allocation
CREATE TABLE allocations (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  booking_id            TEXT NOT NULL REFERENCES bookings(id),
  vehicle_id            TEXT NOT NULL REFERENCES vehicles(id),
  type                  TEXT NOT NULL CHECK (type IN ('IN_TRANSIT','FREE_STOCK','REALLOCATED')),
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED','FULFILLED')),
  needs_transfer        INTEGER NOT NULL DEFAULT 0,   -- car sits at a different outlet than the booking
  allocated_at          TEXT NOT NULL,
  allocated_by          TEXT NOT NULL,                -- 'SYSTEM' or user id (approved manual allocation)
  exception_id          TEXT,
  clock_started_at      TEXT,                         -- payment window starts when the car is at the dealership
  window_extension_days INTEGER NOT NULL DEFAULT 0,
  reminder_sent_at      TEXT,
  escalated_at          TEXT,
  released_at           TEXT,
  release_reason        TEXT,
  fulfilled_at          TEXT,
  rule_trace_json       TEXT NOT NULL DEFAULT '{}',
  source                TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (source IN ('SYSTEM','EXCEPTION','DMS')),  -- DMS = the allotment was made in the DMS and read from a stock report
  dms_confirmed_at      TEXT,                         -- when a stock report first showed this car allotted to this booking
  -- Out of turn: the car went to this booking while an earlier booking for the same car was waiting.
  out_of_turn           INTEGER NOT NULL DEFAULT 0,
  bypassed_booking_id   TEXT,                         -- the earliest booking that was passed over
  bypassed_count        INTEGER NOT NULL DEFAULT 0,
  reviewed_by           TEXT,                         -- for an out-of-turn allocation nobody approved beforehand
  reviewed_at           TEXT,
  review_note           TEXT
);
-- One car, one customer: the database itself refuses a second active allocation.
CREATE UNIQUE INDEX uq_alloc_active_vehicle ON allocations (vehicle_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX uq_alloc_active_booking ON allocations (booking_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_alloc_tenant ON allocations (tenant_id, status);

CREATE TABLE exceptions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  type             TEXT NOT NULL CHECK (type IN
                     ('PRIORITY_CHANGE','SKIP_ALLOCATION','DEFER_DELIVERY','OUTLET_CHANGE','MANUAL_ALLOCATION','WINDOW_EXTENSION','OTHER')),
  booking_id       TEXT NOT NULL REFERENCES bookings(id),
  vehicle_id       TEXT REFERENCES vehicles(id),
  payload_json     TEXT NOT NULL DEFAULT '{}',
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by     TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  decided_by       TEXT,
  decided_at       TEXT,
  decision_remarks TEXT
);
CREATE INDEX idx_exceptions ON exceptions (tenant_id, status);

CREATE TABLE order_requests (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  model         TEXT NOT NULL,
  variant       TEXT NOT NULL,
  colour        TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PLACED','CONFIRMED','CLOSED','CANCELLED')),
  oem_reference TEXT,
  expected_date TEXT,
  notes         TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_order_requests ON order_requests (tenant_id, status);

-- ---------------------------------------------------------------- uploads and reconciliation
CREATE TABLE uploads (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL CHECK (kind IN ('STOCK','BOOKINGS')),
  mode          TEXT NOT NULL DEFAULT 'UPDATE',   -- stock: COMPLETE = the whole stock of the outlets in the file; PARTIAL = only the rows given
  report_date   TEXT,                             -- the date the file describes ("stock as on")
  summary_json  TEXT NOT NULL DEFAULT '{}',       -- what the file said and what was done with it
  status        TEXT NOT NULL DEFAULT 'DONE',     -- RUNNING while a large file is still being applied in steps; EMPTY when not one row was applied
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
CREATE INDEX idx_uploads ON uploads (tenant_id, kind, at);

CREATE TABLE recon_runs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  business_date TEXT NOT NULL,
  trigger       TEXT NOT NULL,          -- SCHEDULED or user id
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  summary_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_recon_runs ON recon_runs (tenant_id, business_date);

CREATE TABLE recon_items (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  run_id          TEXT NOT NULL REFERENCES recon_runs(id),
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('HIGH','MEDIUM','LOW')),
  outlet_id       TEXT,
  entity_type     TEXT,
  entity_id       TEXT,
  message         TEXT NOT NULL,
  detail_json     TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by     TEXT,
  resolved_at     TEXT,
  resolution_note TEXT
);
CREATE INDEX idx_recon_items ON recon_items (tenant_id, run_id);

-- ---------------------------------------------------------------- WhatsApp
CREATE TABLE wa_config (
  tenant_id        TEXT PRIMARY KEY REFERENCES tenants(id),
  provider         TEXT NOT NULL DEFAULT 'TEST' CHECK (provider IN ('TEST','META')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  display_number   TEXT,
  phone_number_id  TEXT,
  waba_id          TEXT,
  access_token_enc TEXT,
  app_secret_enc   TEXT,
  verify_token     TEXT,
  graph_version    TEXT,
  updated_by       TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_wa_config_phone ON wa_config (phone_number_id);

CREATE TABLE wa_templates (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  event_key     TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('CUSTOMER','STAFF')),
  template_name TEXT NOT NULL,          -- name of the approved template in WhatsApp Manager
  language      TEXT NOT NULL DEFAULT 'en',
  body          TEXT NOT NULL,          -- text with {{named}} parameters; must match the approved template
  enabled       INTEGER NOT NULL DEFAULT 1,
  meta_status   TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, event_key)
);

CREATE TABLE wa_messages (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  event_key           TEXT NOT NULL,
  audience            TEXT NOT NULL,
  to_mobile           TEXT NOT NULL,
  to_name             TEXT,
  booking_id          TEXT,
  template_name       TEXT NOT NULL,
  language            TEXT NOT NULL,
  params_json         TEXT NOT NULL DEFAULT '{}',
  rendered_text       TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED')),
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  created_at          TEXT NOT NULL,
  sent_at             TEXT,
  delivered_at        TEXT,
  read_at             TEXT
);
CREATE INDEX idx_wa_messages ON wa_messages (tenant_id, created_at);
CREATE INDEX idx_wa_messages_queue ON wa_messages (status, next_attempt_at);
CREATE INDEX idx_wa_messages_provider ON wa_messages (provider_message_id);

CREATE TABLE wa_inbound (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  from_mobile         TEXT NOT NULL,
  from_name           TEXT,
  message_type        TEXT NOT NULL,
  text                TEXT,
  provider_message_id TEXT,
  received_at         TEXT NOT NULL
);
CREATE INDEX idx_wa_inbound ON wa_inbound (tenant_id, received_at);

-- ---------------------------------------------------------------- alerts and audit
CREATE TABLE alerts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  is_alarm    INTEGER NOT NULL DEFAULT 0, -- an alarm: something that needs the Business Head / CEO or the Dealer Principal
  target_role TEXT,                       -- every user with this role (within their outlets), or
  target_user TEXT,                       -- one named user, for example the sales executive of a booking
  outlet_id   TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX idx_alerts ON alerts (tenant_id, target_role, created_at);
CREATE INDEX idx_alerts_user ON alerts (tenant_id, target_user, created_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log (tenant_id, entity_type, entity_id, at);
CREATE INDEX idx_audit_time ON audit_log (tenant_id, at);

-- The audit trail and stock movement history are append-only.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER vehicle_events_no_update BEFORE UPDATE ON vehicle_events
BEGIN SELECT RAISE(ABORT, 'vehicle_events is append-only'); END;
CREATE TRIGGER vehicle_events_no_delete BEFORE DELETE ON vehicle_events
BEGIN SELECT RAISE(ABORT, 'vehicle_events is append-only'); END;
