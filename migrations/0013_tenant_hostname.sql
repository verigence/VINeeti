-- The address a dealership reaches VINeeti at: adityamotors.mh.jbrconsulting.in. Held here rather than
-- worked out from the URL, so the naming scheme stays a decision and not a parsing rule — a dealership
-- can be renamed, moved to another manufacturer's group, or given a second address, without code.
--
-- A dealership with two manufacturers is already two dealerships here, each with its own data and its
-- own people, so each has its own address and neither can show the other's.
ALTER TABLE tenants ADD COLUMN hostname TEXT;
CREATE UNIQUE INDEX idx_tenants_hostname ON tenants (hostname) WHERE hostname IS NOT NULL;

UPDATE tenants SET hostname = 'adityamotors.mh.jbrconsulting.in' WHERE slug = 'aditya' AND hostname IS NULL;
