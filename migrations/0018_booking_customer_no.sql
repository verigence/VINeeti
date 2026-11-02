-- The DMS's own customer number on a booking, where the booking export gives one (Hyundai's Cust. No).
-- Hyundai's retail export names no booking; it names this number (CustomerID), and that is how an
-- invoice finds its booking.
ALTER TABLE bookings ADD COLUMN dms_customer_no TEXT;
CREATE INDEX idx_bookings_dms_customer_no ON bookings (tenant_id, dms_customer_no) WHERE dms_customer_no IS NOT NULL;
