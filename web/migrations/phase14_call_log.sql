-- Phase 14 — record every click-to-dial, so calls can be counted properly.
--
-- WHY THIS EXISTS
-- The counter previously worked off sales-stage changes (phase13), on the
-- assumption that a stage change meant a call. In practice plenty of calls
-- don't move the stage, so the number read low and undersold the work done.
-- The owner's rule now: EVERY click on a phone number is one call. No
-- de-duplication — clicking the same number twice is two calls, because a
-- redial after no answer is a real second attempt.
--
-- Stage changes no longer feed the counter at all. phase13's table is left in
-- place, still recording quietly, so the history isn't thrown away and the
-- counter could be switched back or combined later without a gap.
--
-- contact_id : nullable and ON DELETE SET NULL on purpose. Deleting a company
--              must NOT retroactively reduce past call counts — the call still
--              happened. Also allows logging a dial that isn't tied to a
--              company record.
-- user_id    : ON DELETE SET NULL for the same reason — removing a user must
--              not erase the record of calls they made.
-- phone      : kept for later reporting (which numbers get rung most). Not
--              used by the counter.
-- called_at  : TIMESTAMPTZ, so the instant is unambiguous. Counting is done
--              per LONDON calendar day in the route, NOT per UTC day — under
--              British Summer Time a call at 00:30 local is still the previous
--              day in UTC and would land on the wrong day.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) and self-sufficient: it
-- assumes no earlier phase has run. NOTE migrations sort ALPHABETICALLY, not
-- numerically, so 'phase14_' runs after 'phase13_' and 'phase12_' but BEFORE
-- 'phase4_'..'phase9_'. It only references the base tables created by the
-- 'create_*' migrations, which sort before every 'phase*' file. No money.

CREATE TABLE IF NOT EXISTS contact_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  phone           TEXT,
  called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The counter query is always "this organisation, this day".
CREATE INDEX IF NOT EXISTS idx_contact_calls_org_time
  ON contact_calls (organisation_id, called_at DESC);

-- Supports a per-person breakdown later without another migration.
CREATE INDEX IF NOT EXISTS idx_contact_calls_user_time
  ON contact_calls (user_id, called_at DESC);
