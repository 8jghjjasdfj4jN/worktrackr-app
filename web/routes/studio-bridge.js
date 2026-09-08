// web/routes/studio-bridge.js
//
// INBOUND bridge — Sweetbyte Studio calls WorkTrackr.
//
// Every other Studio↔WorkTrackr route runs the other way: WorkTrackr signs a
// request and asks Studio to do something. This one is the reverse. Studio's
// keep-warm email feature needs to know each company's CURRENT sales stage so
// it can drop anyone who has gone dead before the next email goes out.
//
// WHY A SEPARATE FILE AND A SEPARATE MOUNT
// routes/service-emails.js is mounted behind authenticateToken — it is called
// by a logged-in salesperson's browser. This router has no user behind it at
// all; it authenticates with the shared HMAC instead. Mixing the two auth
// models in one router is exactly how a bridge endpoint accidentally becomes
// reachable from a browser session, or vice versa. Keep them apart.
//
// SIGNING — identical scheme to services/serviceEmailBridge.js, same secret:
//   payload = "<expiryUnixSeconds>.<nonce>.<METHOD>.<PATH>"
//   sig     = HMAC-SHA256(WORKTRACKR_SERVICE_EMAIL_SECRET, payload)  hex
//   header  = X-WT-Signature: <expiry>.<nonce>.<sig>
//
// PATH is the route path within this mount — "/stages", not
// "/api/studio-bridge/stages".
//
// TENANCY — READ THIS BEFORE CHANGING ANYTHING
// There is no user on this request, so there is no organisation to infer.
// The organisation is pinned by STUDIO_BRIDGE_ORG_ID and the query is filtered
// on it. Without that filter this endpoint would hand Sweetbyte's Studio every
// contact belonging to every WorkTrackr tenant. If the variable is unset the
// route returns 500 and serves nothing — failing closed is the only acceptable
// behaviour here.
//
// Env:
//   WORKTRACKR_SERVICE_EMAIL_SECRET  (required) — must match Studio's value.
//   STUDIO_BRIDGE_ORG_ID             (required) — the organisations.id row that
//                                    owns the Sweetbyte sales pipeline.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('@worktrackr/shared/db');

// ── HMAC verification ────────────────────────────────────────────────────────

function requireBridgeAuth(req, res, next) {
  const secret = process.env.WORKTRACKR_SERVICE_EMAIL_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'WORKTRACKR_SERVICE_EMAIL_SECRET is not set' });
  }

  const header = req.get('X-WT-Signature') || '';
  const parts = header.split('.');
  if (parts.length !== 3) return res.status(401).json({ error: 'Malformed signature' });

  const [expiry, nonce, sig] = parts;
  const expiryNum = Number(expiry);
  if (!Number.isFinite(expiryNum) || expiryNum < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ error: 'Signature expired' });
  }

  const payload = `${expiry}.${nonce}.${req.method}.${req.path}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Bad signature' });
  }

  next();
}

// ── GET /api/studio-bridge/stages ────────────────────────────────────────────
//
// Every company in the pinned organisation, with the sales stage as it stands
// right now. Studio matches these against the addresses it has already emailed
// and rebuilds its own audience from the result.
//
// Deliberately returns EVERY company rather than only the ones Studio asks
// about. Studio needs to see a company that has moved to dead just as much as
// one that is still live — a filtered response would silently omit exactly the
// rows that matter. A few thousand rows of id/name/stage is a small payload.
//
// A company with no stage set comes back as stage: null. That is a real value
// meaning "No stage", not missing data, and Studio treats it as such.
router.get('/stages', requireBridgeAuth, async (req, res) => {
  const orgId = process.env.STUDIO_BRIDGE_ORG_ID;
  if (!orgId) {
    console.error('[studio-bridge] STUDIO_BRIDGE_ORG_ID is not set — refusing to serve contacts');
    return res.status(500).json({ error: 'STUDIO_BRIDGE_ORG_ID is not set' });
  }

  try {
    const result = await query(
      `SELECT id,
              name,
              email,
              primary_contact,
              crm->>'salesStage' AS sales_stage
         FROM contacts
        WHERE organisation_id = $1`,
      [orgId]
    );

    const companies = result.rows.map((r) => ({
      id: String(r.id),
      name: r.name || null,
      email: r.email || null,
      primaryContact: r.primary_contact || null,
      stage: r.sales_stage || null,
    }));

    res.json({ companies, count: companies.length, at: new Date().toISOString() });
  } catch (err) {
    console.error('[studio-bridge] stages query failed:', err.message);
    res.status(500).json({ error: 'Could not read contacts' });
  }
});

// ── GET /api/studio-bridge/ping ──────────────────────────────────────────────
// Signed no-op so Studio can prove the secret and the base URL are right
// without pulling the whole contact list. Reports whether the org is pinned.
router.get('/ping', requireBridgeAuth, (req, res) => {
  res.json({ ok: true, orgPinned: !!process.env.STUDIO_BRIDGE_ORG_ID });
});

module.exports = router;
