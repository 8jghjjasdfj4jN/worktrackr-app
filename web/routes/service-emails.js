// web/routes/service-emails.js
//
// Service emails — the WorkTrackr half of the Sweetbyte Studio integration.
//
// After a cold call the salesperson types the address they were given, taps
// one or more services, and taps Send. This route signs the request, hands it
// to Studio, and records what happened locally. Studio owns everything after
// that: the 10-second undo window, the send, the 7-day follow-up, suppression.
//
// Contract is documented in Sweetbyte's SERVICE_EMAILS_INTEGRATION.md. Keep the
// two in step.
//
// HMAC signing lives in services/serviceEmailBridge.js, shared with
// routes/contacts.js. Env vars are documented there.

const express = require('express');
const { z } = require('zod');
const router = express.Router();
const { query, getOrgContext } = require('@worktrackr/shared/db');
const { callStudio } = require('../services/serviceEmailBridge');

// ── Catalogue ────────────────────────────────────────────────────────────────
// Cached in memory so opening ten company records doesn't make ten signed
// calls. Five minutes is short enough that a newly added service appears
// without a redeploy, long enough to be useful across a calling session.
// Process-local by design: a restart just refetches.
let catalogueCache = { at: 0, services: null };
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

router.get('/catalogue', async (req, res) => {
  try {
    if (catalogueCache.services && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
      return res.json({ services: catalogueCache.services, cached: true });
    }
    const r = await callStudio('GET', '/catalogue');
    if (!r.ok) {
      // Serve a stale cache rather than an empty chip grid — a slightly old
      // service list is far more useful than none.
      if (catalogueCache.services) {
        return res.json({ services: catalogueCache.services, stale: true });
      }
      return res.status(502).json({ error: 'Could not reach Sweetbyte Studio' });
    }
    catalogueCache = { at: Date.now(), services: r.json.services || [] };
    res.json({ services: catalogueCache.services });
  } catch (err) {
    console.error('Service email catalogue failed:', err.message);
    if (catalogueCache.services) return res.json({ services: catalogueCache.services, stale: true });
    res.status(500).json({ error: 'Could not load services' });
  }
});

// ── Local mirror read ────────────────────────────────────────────────────────
// GET /api/service-emails/company/:contactId?email=…
// Powers chip state. Reads the local mirror only — no network call, so the
// panel renders with the page.
router.get('/company/:contactId', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const { contactId } = req.params;
    const email = String(req.query.email || '').trim().toLowerCase();

    const all = await query(
      `SELECT id, remote_id, to_email, services, status, created_at
         FROM service_email_sends
        WHERE contact_id = $1 AND organisation_id = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [contactId, organizationId]
    );

    // Services already used against THIS address. Cancelled sends don't count —
    // an undone email was never sent, so the service is still available.
    const sentServices = new Set();
    for (const row of all.rows) {
      if (row.status === 'cancelled') continue;
      if (email && String(row.to_email || '').toLowerCase() !== email) continue;
      for (const s of row.services || []) sentServices.add(s);
    }

    res.json({
      sentServices: Array.from(sentServices),
      history: all.rows.map((r) => ({
        id: r.id,
        remoteId: r.remote_id,
        toEmail: r.to_email,
        services: r.services || [],
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('Service email history failed:', err.message);
    res.status(500).json({ error: 'Could not load send history' });
  }
});

// ── Send ─────────────────────────────────────────────────────────────────────
const sendSchema = z.object({
  contactId: z.string().uuid(),
  email: z.string().email(),
  // Optional, and nullable: the panel sends null when the box is left blank,
  // which is meaningful — it means "fall back to the company's primary
  // contact, then to 'Hi there'". Capped because it lands in a subject line.
  contactName: z.string().trim().max(80).nullish(),
  services: z.array(z.string().min(1)).min(1).max(20),
});

// Real send outcome, straight from Studio. The local mirror is written at send
// time and never learns what SES did, so it cannot answer "did it actually go".
// This asks Studio, which owns the truth.
//
// Deliberately uncached: it is polled for a few seconds after a send and a
// stale answer is worse than no answer.
router.get('/status/:remoteId', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const { remoteId } = req.params;
    const contactId = String(req.query.contactId || '');

    // Confirm the caller owns this company before asking Studio about it.
    const c = await query(
      `SELECT id FROM contacts WHERE id = $1 AND organisation_id = $2`,
      [contactId, organizationId]
    );
    if (c.rows.length === 0) return res.status(404).json({ error: 'Company not found' });

    const studio = await callStudio('GET', '/status', {
      queryString: `externalCompanyId=${encodeURIComponent(contactId)}`,
    });
    if (!studio.ok) return res.status(502).json({ error: 'Could not reach Sweetbyte Studio' });

    const row = (studio.json?.history || []).find(h => h.id === remoteId);
    if (!row) return res.json({ status: 'unknown' });

    // Keep the local mirror honest too, so the timeline and chip state stop
    // claiming a failed send went out.
    if (row.status && row.status !== 'queued') {
      await query(
        `UPDATE service_email_sends SET status = $1
          WHERE remote_id = $2 AND organisation_id = $3`,
        [row.status, remoteId, organizationId]
      ).catch(() => {});
    }

    res.json({ status: row.status, error: row.error || null, sentAt: row.sentAt || null });
  } catch (err) {
    console.error('Service email status failed:', err.message);
    res.status(500).json({ error: 'Could not check status' });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);

    const parsed = sendSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
    const { contactId, email, contactName, services } = parsed.data;

    // Company details come from the DB, never from the request body — the
    // client shouldn't be able to put someone else's company name on an email.
    const c = await query(
      `SELECT id, name, primary_contact FROM contacts
        WHERE id = $1 AND organisation_id = $2`,
      [contactId, organizationId]
    );
    if (c.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = c.rows[0];

    // Name: what the caller typed wins, because they have just been told it on
    // the phone and the stored primary contact may be months stale or absent.
    // Falling through to null is fine — Studio opens with "Hi there" and drops
    // the name from the subject entirely.
    //
    // Note this is the ONE field taken from the request body. The company name
    // is not: the client shouldn't be able to put someone else's company on an
    // email, whereas a mistyped first name is only ever the sender's own
    // problem and is worth far more than an empty greeting.
    const nameForEmail = (contactName && contactName.trim())
      || company.primary_contact
      || null;

    const studio = await callStudio('POST', '/send', {
      body: {
        externalCompanyId: contactId,
        companyName: company.name,
        contactName: nameForEmail,
        toEmail: email,
        services,
      },
    });

    if (!studio.ok) {
      // Pass Studio's reason through untranslated so the panel can explain
      // itself properly. These are answers, not failures.
      return res.status(studio.status === 409 ? 409 : 502).json({
        error: studio.json?.error || 'Send refused',
        already: studio.json?.already,
      });
    }

    const sentKeys = studio.json.services || services;

    // Timeline entry. Written now rather than after the undo window because
    // WorkTrackr has no scheduler — undo deletes it again, so an undone email
    // leaves no trace.
    const noteBody =
      `Service email sent to ${email} — ${sentKeys.join(', ')}. ` +
      `Follow-up scheduled for 7 days' time.`;
    const note = await query(
      `INSERT INTO contact_notes (organisation_id, contact_id, kind, subject, body, created_by)
       VALUES ($1, $2, 'email', $3, $4, $5)
       RETURNING id`,
      [organizationId, contactId, 'Service email', noteBody, req.user.userId]
    );

    const mirror = await query(
      `INSERT INTO service_email_sends
         (organisation_id, contact_id, remote_id, to_email, services, status, note_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)
       RETURNING id`,
      [organizationId, contactId, studio.json.id, email, sentKeys, note.rows[0].id, req.user.userId]
    );

    res.json({
      id: mirror.rows[0].id,
      remoteId: studio.json.id,
      services: sentKeys,
      skipped: studio.json.skipped || [],
      sendAfter: studio.json.sendAfter,
    });
  } catch (err) {
    console.error('Service email send failed:', err.message);
    res.status(500).json({ error: 'Could not reach Sweetbyte Studio' });
  }
});

// ── Undo ─────────────────────────────────────────────────────────────────────
// POST /api/service-emails/cancel  { id }  — id is the LOCAL mirror id.
router.post('/cancel', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });

    const row = await query(
      `SELECT id, remote_id, note_id FROM service_email_sends
        WHERE id = $1 AND organisation_id = $2`,
      [id, organizationId]
    );
    if (row.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const { remote_id, note_id } = row.rows[0];

    const studio = await callStudio('POST', '/cancel', { body: { id: remote_id } });

    // Studio is the authority on whether the email actually stopped. If it says
    // too_late the email has gone, and the mirror and the timeline must keep
    // saying so — silently tidying up here would leave the salesperson
    // believing an email was pulled back when it wasn't.
    if (!studio.ok) {
      return res.status(409).json({ error: studio.json?.error || 'too_late' });
    }

    await query(`UPDATE service_email_sends SET status = 'cancelled' WHERE id = $1`, [id]);
    if (note_id) {
      await query(`DELETE FROM contact_notes WHERE id = $1 AND organisation_id = $2`,
        [note_id, organizationId]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Service email cancel failed:', err.message);
    res.status(500).json({ error: 'Could not reach Sweetbyte Studio' });
  }
});

// ── Reconciliation ───────────────────────────────────────────────────────────
// GET /api/service-emails/company/:contactId/status
// Studio's authoritative view. Not used for rendering — for when the mirror
// looks wrong and you want the truth.
router.get('/company/:contactId/status', async (req, res) => {
  try {
    await getOrgContext(req.user.userId);
    const { contactId } = req.params;
    const email = String(req.query.email || '');
    const qs = new URLSearchParams({ externalCompanyId: contactId });
    if (email) qs.set('email', email);

    const studio = await callStudio('GET', '/status', { queryString: qs.toString() });
    if (!studio.ok) return res.status(502).json({ error: 'Could not reach Sweetbyte Studio' });
    res.json(studio.json);
  } catch (err) {
    console.error('Service email status failed:', err.message);
    res.status(500).json({ error: 'Could not reach Sweetbyte Studio' });
  }
});

module.exports = router;
