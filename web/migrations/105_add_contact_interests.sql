-- 105_add_contact_interests.sql
--
-- What a prospect said they were interested in during a call.
--
-- Stored against EVERY contact, not just hot prospects. The list column only
-- displays it on the hot prospect view, but a suspect who mentions VoIP should
-- have that recorded there and then — it is already waiting when they are
-- promoted, rather than being lost because they were not hot enough yet.
--
-- TEXT[] rather than a join table: the values are a short fixed vocabulary
-- defined in code (SERVICE_INTERESTS in contacts.js), there is no per-interest
-- data to hang off a row, and a GIN index makes "who wants VoIP" fast enough.
-- A join table would be three more files for no gain.
--
-- Empty array, never NULL, so the read path never has to handle both.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}';

-- Supports containment queries such as:
--   SELECT ... WHERE interests @> ARRAY['voip']
CREATE INDEX IF NOT EXISTS idx_contacts_interests
  ON contacts USING GIN (interests);
