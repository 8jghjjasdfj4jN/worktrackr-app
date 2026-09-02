-- web/migrations/create_service_email_sends.sql
--
-- Local mirror of service emails handed to Sweetbyte Studio.
--
-- Studio is the source of truth: it owns the queue, the 7-day follow-up and
-- the suppression list. This table exists so the company profile can render
-- chip state (which services have already gone to which address) without a
-- signed round-trip to another service on every page load — that round-trip
-- is the difference between the panel appearing instantly and appearing after
-- a beat, and this panel is used between calls where a beat is the whole
-- complaint.
--
-- Consequence worth knowing: the mirror can drift. If Studio suppresses a send
-- the mirror still says 'queued'. GET /api/service-emails/company/:id/status
-- reconciles against Studio on demand for when the truth matters.
--
-- Idempotent and self-sufficient: safe to run repeatedly, creates everything
-- it references, and depends only on tables that already exist.

CREATE TABLE IF NOT EXISTS service_email_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Studio's row id. The handle for cancelling (undo) and for reconciliation.
  remote_id       TEXT NOT NULL,

  to_email        TEXT NOT NULL,

  -- Service keys as sent. Deliberately TEXT[] rather than a foreign key: the
  -- catalogue lives in Studio and is read over the wire, so there is no local
  -- table to point at. Storing what was actually sent also keeps history
  -- readable if a key is ever retired.
  services        TEXT[] NOT NULL DEFAULT '{}',

  -- queued | sent | cancelled — mirrors Studio's vocabulary, minus the states
  -- that only matter inside Studio's send loop.
  status          TEXT NOT NULL DEFAULT 'queued',

  -- The contact_notes row written for the timeline, so undo can remove it and
  -- leave no trace of an email that never went.
  note_id         UUID REFERENCES contact_notes(id) ON DELETE SET NULL,

  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The chip-state lookup: everything sent to one address for one company.
CREATE INDEX IF NOT EXISTS idx_service_email_sends_contact_email
  ON service_email_sends (contact_id, lower(to_email));

-- Timeline and reconciliation reads.
CREATE INDEX IF NOT EXISTS idx_service_email_sends_contact
  ON service_email_sends (contact_id, created_at DESC);

-- Undo looks the row up by Studio's id.
CREATE INDEX IF NOT EXISTS idx_service_email_sends_remote
  ON service_email_sends (remote_id);
