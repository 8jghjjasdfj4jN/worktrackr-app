-- Phase 13 — record every sales-stage change on a company.
--
-- WHY THIS EXISTS
-- The company record only ever held its CURRENT stage. Nothing anywhere
-- recorded WHEN a stage changed or WHO changed it, so "how many calls did I
-- make today" was unanswerable — the information had never been written down.
-- This table starts recording it. It can only ever count from the day it is
-- deployed; earlier activity is NOT recoverable.
--
-- WHAT COUNTS AS A CALL
-- The owner's rule: any change of sales stage means a call was made. Rows are
-- written by routes/contacts.js on PUT /:id when the stage actually differs
-- from what was stored. Creating a company already staged is NOT a change and
-- is deliberately not logged here.
--
-- from_stage : the stage before the change. NULL means the company had no
--              stage at all ("No stage"), which is a real and common case —
--              it is not a missing value.
-- to_stage   : the stage after the change. NULL means it was cleared back to
--              "No stage", which is also a legitimate move.
-- user_id    : who made the change. ON DELETE SET NULL so removing a user
--              never deletes the history of the calls they made.
-- changed_at : TIMESTAMPTZ, so the instant is stored unambiguously. Counting
--              is done per LONDON calendar day in the route, NOT per UTC day —
--              under British Summer Time a call at 00:30 local is still the
--              previous day in UTC and would be counted against the wrong day.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) and self-sufficient: it
-- assumes no earlier phase has run. NOTE migrations sort ALPHABETICALLY, not
-- numerically, so 'phase13_' runs after 'phase12_' but BEFORE 'phase8_'. It
-- only references the base tables created by the 'create_*' migrations, which
-- sort before every 'phase*' file. No money figures.

CREATE TABLE IF NOT EXISTS contact_stage_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  from_stage      TEXT,
  to_stage        TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The counter query is always "this organisation, this user, this day", so
-- lead with those three columns.
CREATE INDEX IF NOT EXISTS idx_stage_changes_org_user_time
  ON contact_stage_changes (organisation_id, user_id, changed_at DESC);

-- Supports showing one company's stage history later without another migration.
CREATE INDEX IF NOT EXISTS idx_stage_changes_contact
  ON contact_stage_changes (contact_id, changed_at DESC);
