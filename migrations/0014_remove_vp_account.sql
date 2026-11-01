-- Removes the "VP" account at Aditya Motors, asked for by the product owner on 1 November 2026.
--
-- It is not an ordinary removal: the account decided seven release-allocation requests on real customer
-- bookings between 17 and 19 October (OTF27A070885, OTF27A064450, OTF26A124675, OTF27B016105,
-- OTF27B018910, OTF27A065079, OTF26A116491), which is why the product refuses to delete it. Those
-- decisions are deliberately left where they are: deleting them would remove the explanation for why
-- those cars changed hands. What goes is the account, so the decisions keep their id and lose their
-- name — the screens show "Removed account" against them rather than a blank.
--
-- Done here rather than in the product because a dealership administrator should not be able to erase
-- an approver: this is one account, named, on the record, and reviewable.
DELETE FROM user_outlets  WHERE user_id = 'usr_47cc50c1948fa6ce4bcc';
DELETE FROM user_segments WHERE user_id = 'usr_47cc50c1948fa6ce4bcc';
DELETE FROM password_otps WHERE user_id = 'usr_47cc50c1948fa6ce4bcc';
UPDATE bookings SET sales_exec_id = NULL WHERE sales_exec_id = 'usr_47cc50c1948fa6ce4bcc';

-- Why seven decisions have no name against them, written down before the name goes.
INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at)
SELECT 'aud_vpremoval20261101', u.tenant_id, 'DEPLOY', 'USER_DELETED', 'user', u.id,
       json_object('name', u.name, 'mobile', u.mobile, 'role', u.role,
                   'asked_by', 'product owner',
                   'decisions_left_in_place', (SELECT COUNT(*) FROM exceptions e WHERE e.decided_by = u.id OR e.requested_by = u.id),
                   'note', 'Account removed at the product owner''s request. The release decisions it made are kept and now show no decider.'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM users u WHERE u.id = 'usr_47cc50c1948fa6ce4bcc';

DELETE FROM users WHERE id = 'usr_47cc50c1948fa6ce4bcc';
