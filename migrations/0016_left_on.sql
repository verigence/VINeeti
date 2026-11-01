-- When somebody leaves.
--
-- Until now the only way to deal with a departure was to switch the account off, which said nothing
-- about why: an account off for a fortnight's suspension looked exactly like one off because its
-- owner left in March. A date says which, and it is the date the dealership cares about.
--
-- Leaving is not deletion. The record of what a person did keeps their name, because an allocation
-- somebody signed off is theirs whether or not they still work here. What has to move on instead is
-- the desk: the work they held, and the DMS ID the manufacturer's system knows that desk by, so the
-- person who replaces them picks up where they left off.
ALTER TABLE users ADD COLUMN left_on TEXT;

-- Everybody switched off before this existed has no date, which reads as "off" rather than "left" —
-- which is all that was ever recorded about them, so inventing a date would be making it up.
