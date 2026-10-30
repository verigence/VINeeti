-- System health: what the deployment itself is doing, kept for the platform console. Nothing here belongs
-- to a dealership and nothing here is customer data.
--
-- The Worker counts in memory and writes one batch a minute at most, so these tables cost a few hundred
-- rows a day, not one per request. Rows older than their keep are removed by the scheduled job.

-- One row per minute and route group, summed across every isolate that was running. The per-request
-- counts come from the Worker itself; the database figures come from the meta D1 returns with each query.
CREATE TABLE health_minutes (
  minute          TEXT NOT NULL,                 -- 'YYYY-MM-DDTHH:MM', UTC
  group_name      TEXT NOT NULL,                 -- auth, eod, stock, bookings, ops, master, platform, webhook, cron, assets, other
  requests        INTEGER NOT NULL DEFAULT 0,
  ok              INTEGER NOT NULL DEFAULT 0,    -- 2xx and 3xx
  client_errors   INTEGER NOT NULL DEFAULT 0,    -- 4xx
  server_errors   INTEGER NOT NULL DEFAULT 0,    -- 5xx
  ms_total        INTEGER NOT NULL DEFAULT 0,    -- time to answer, as the Worker sees it
  ms_max          INTEGER NOT NULL DEFAULT 0,
  fast            INTEGER NOT NULL DEFAULT 0,    -- under 200 ms
  slow            INTEGER NOT NULL DEFAULT 0,    -- 2 s and over
  db_queries      INTEGER NOT NULL DEFAULT 0,
  db_ms_total     INTEGER NOT NULL DEFAULT 0,
  db_ms_max       INTEGER NOT NULL DEFAULT 0,
  db_rows_read    INTEGER NOT NULL DEFAULT 0,
  db_rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, group_name)
);

-- Every isolate that has served a request: when it started (a cold start), where, and when it was last seen.
CREATE TABLE health_isolates (
  boot_id      TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  colo         TEXT,
  version      TEXT,
  requests     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_health_isolates_seen ON health_isolates (last_seen_at);

-- One row per firing of the scheduled job.
CREATE TABLE health_cron_runs (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1,        -- 0 when the firing itself threw, or any dealership's step did
  tenants     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_health_cron_started ON health_cron_runs (started_at);

-- Failures the Worker answered with a 5xx, or that the scheduled job hit. One row per distinct failure
-- per hour, with a count, so a storm of the same error is one line rather than a thousand.
CREATE TABLE health_errors (
  hour        TEXT NOT NULL,                     -- 'YYYY-MM-DDTHH', UTC
  fingerprint TEXT NOT NULL,                     -- hash of source, status, code, message and route
  source      TEXT NOT NULL,                     -- HTTP or CRON
  route       TEXT,                              -- method and path with ids replaced
  status      INTEGER,
  code        TEXT,
  message     TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  PRIMARY KEY (hour, fingerprint)
);
CREATE INDEX idx_health_errors_last ON health_errors (last_at);

-- Small facts worth keeping between requests: the database size D1 last reported, the version last deployed.
CREATE TABLE health_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL
);
