-- Who signed in, from where, and when — successes and failures alike. A log of successes alone answers
-- "was it me?" but not "is somebody trying?", and the second question is the one a dealership asks after
-- something has gone wrong. A refused attempt therefore gets a row too, with the number that was tried.
--
-- The IP address is personal data. It is kept because it is the only thing that distinguishes the
-- dealership's own office from somewhere else, and it is kept for 180 days rather than for ever: the
-- nightly job deletes older rows, so the log answers "who has been signing in lately" and does not
-- quietly become a permanent record of where each employee was.
CREATE TABLE sign_ins (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT,                    -- null when the attempt matched no account
  mobile      TEXT NOT NULL,           -- as typed, so a wrong number is visible rather than lost
  name        TEXT,                    -- kept as written, so the row still reads after a rename
  role        TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('IN', 'REFUSED', 'LOCKED')),
  ip          TEXT,
  country     TEXT,
  client      TEXT,                    -- APP when it came from the installed app, BROWSER otherwise
  user_agent  TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX idx_sign_ins_tenant ON sign_ins (tenant_id, at DESC);
CREATE INDEX idx_sign_ins_user ON sign_ins (tenant_id, user_id, at DESC);
CREATE INDEX idx_sign_ins_at ON sign_ins (at);
