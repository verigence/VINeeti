-- XUV700 reached the master from the booking sheet alone, and a booking sheet carries no category. With
-- no sibling variant from a stock report to take one from, 0009's backfill could not place it, leaving
-- it the one model in the system whose segment was unknown — which quietly keeps it out of the reach of
-- anybody scoped to a segment, now that allocation requests are raised segment by segment.
--
-- It is a passenger vehicle: Mahindra's PERSONAL. Set only where it is still blank, so a dealership that
-- has since corrected it on the Master screen keeps what it chose.
UPDATE vehicle_variants SET category = 'PERSONAL'
 WHERE TRIM(category) = ''
   AND model = 'XUV700'
   AND tenant_id IN (SELECT id FROM tenants WHERE UPPER(oem) = 'MAHINDRA');
