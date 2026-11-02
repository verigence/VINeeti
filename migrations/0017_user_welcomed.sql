-- When a person was shown the welcome screen. Shown once, the first time they reach the application
-- itself -- after the temporary password has been replaced -- and never again on any device, which is
-- why it is kept here rather than in the browser.
--
-- Everybody already using the system has, in effect, been welcomed: they are not interrupted by it on
-- the day it arrives. Only people who have not yet set their own password will see it.
ALTER TABLE users ADD COLUMN welcomed_at TEXT;
UPDATE users SET welcomed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE must_change_password = 0;
