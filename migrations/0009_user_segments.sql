-- Segments: which kinds of vehicle a person works with (passenger, electric, commercial), beside which
-- outlets. A segment is the manufacturer's own category on the vehicle master (vehicle_variants.category:
-- for Mahindra PERSONAL, BEV, PROSPER), so it follows the stock report and nobody types it. A person with
-- no row here works with every segment, as a person with all_outlets works with every outlet.
CREATE TABLE user_segments (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  segment   TEXT NOT NULL,
  PRIMARY KEY (user_id, segment)
);
CREATE INDEX idx_user_segments_tenant ON user_segments (tenant_id, user_id);

-- A variant registered from a booking sheet has no category, because the sheet does not carry one. A
-- model's category is the same for all its variants, so where a sibling from a stock report knows it,
-- the blank is filled from the sibling. The import now does the same for new variants.
UPDATE vehicle_variants SET category = (
  SELECT s.category FROM vehicle_variants s
   WHERE s.tenant_id = vehicle_variants.tenant_id AND s.model = vehicle_variants.model AND s.category <> ''
   ORDER BY s.origin DESC, s.created_at LIMIT 1
) WHERE category = '' AND EXISTS (
  SELECT 1 FROM vehicle_variants s WHERE s.tenant_id = vehicle_variants.tenant_id AND s.model = vehicle_variants.model AND s.category <> ''
);
