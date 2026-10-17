-- The retail invoice export: the third file the dealership produces every evening.
--
-- Until now retail was inferred rather than read. The stock report says a chassis carries an invoice
-- id and a date, so a car could be counted as sold; everything the dealership actually earned on it
-- -- what was discounted and by whom, what the manufacturer owes back, who financed it, who insured
-- it, when it was really handed over -- was in a file nothing loaded.
--
-- Not all of it is kept. The export runs to a hundred and fifty columns and most of them are empty
-- for this dealership or repeat what the stock report already carries; forty-odd columns are empty
-- on every row. What is stored is what somebody would act on: the money, the claims, the attached
-- business, and the delivery note, which is the only honest source for how long a car sat invoiced
-- before the customer took it away.
--
-- Keyed by invoice number. A retail invoice is withdrawn by disappearing from the export -- no
-- cancellation column is ever filled -- so a row that stops being listed is the only cancellation
-- signal there is, and `withdrawn_on` is how that is recorded without deleting the row.

CREATE TABLE retail_invoices (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  invoice_no           TEXT NOT NULL,
  invoice_at           TEXT,                       -- the instant the DMS stamped it
  invoice_date         TEXT,                       -- the dealership's business date
  status               TEXT,
  outlet_id            TEXT REFERENCES outlets(id),

  -- what was sold, and to which order
  vin                  TEXT,
  chassis_no           TEXT,
  vehicle_id           TEXT REFERENCES vehicles(id),
  booking_no           TEXT,
  booking_id           TEXT REFERENCES bookings(id),
  allotment_id         TEXT,
  oem_model_code       TEXT,
  model                TEXT,
  variant              TEXT,
  colour               TEXT,

  -- who bought it
  customer_name        TEXT,
  customer_type        TEXT,                       -- INDIVIDUAL or CORPORATE, as the DMS has it
  customer_gstin       TEXT,
  sc_name              TEXT,

  -- the money
  invoice_amount       REAL,
  selling_price        REAL,                       -- before tax
  gst_amount           REAL,
  tcs_amount           REAL,

  -- what was given away, and who is funding it. The dealer's own margin and the manufacturer's
  -- schemes are kept apart because only one of them is recoverable.
  dealer_discount      REAL,
  oem_scheme_discount  REAL,
  loyalty_discount     REAL,
  exchange_discount    REAL,
  corporate_discount   REAL,

  -- the claim trail. A discount given with no credit note is money the dealership has not asked for.
  bndp_credit_note     TEXT,
  loyalty_credit_note  TEXT,
  exchange_credit_note TEXT,

  -- the business attached to the sale
  financier            TEXT,
  finance_arranged_by  TEXT,                       -- DEALER, SELF or DSA
  finance_amount       REAL,
  insurer              TEXT,
  insurance_amount     REAL,
  exchange_indicator   TEXT,

  -- handover and compliance
  delivery_note_no     TEXT,
  delivery_note_date   TEXT,
  irn_at               TEXT,                       -- e-invoice; only a B2B sale has one

  report_date          TEXT NOT NULL,              -- the export this row was last seen in
  -- Set on the day the invoice stopped being listed. The row is kept: an invoice that was withdrawn
  -- is a thing that happened, and erasing it would lose the only record that it did.
  withdrawn_on         TEXT,
  last_upload_id       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (tenant_id, invoice_no)
);

CREATE INDEX idx_retail_date ON retail_invoices (tenant_id, invoice_date);
CREATE INDEX idx_retail_vin ON retail_invoices (tenant_id, vin);
CREATE INDEX idx_retail_booking ON retail_invoices (tenant_id, booking_no);
