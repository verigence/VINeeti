-- Where an outlet actually is. The DMS files carry a location code and a short name ("AD01", "CUTTACK")
-- and nothing else, so the address is the dealership's own to enter: it is what a customer is told when
-- a car has to be collected from another branch, and what a transfer between outlets is judged by.
ALTER TABLE outlets ADD COLUMN address TEXT;
