// web/services/serviceEmailBridge.js
//
// Signed server-to-server calls to Sweetbyte Studio for service emails.
//
// Lives in services/ rather than inside the route because two callers need it:
// routes/service-emails.js (send, cancel, catalogue) and routes/contacts.js
// (cancelling follow-ups when a company moves to dead or customer). Duplicating
// HMAC signing across two files is exactly the kind of thing that drifts.
//
// Contract: Sweetbyte's SERVICE_EMAILS_INTEGRATION.md. Keep the two in step.
//
//   payload = "<expiryUnixSeconds>.<nonce>.<METHOD>.<PATH>"
//   sig     = HMAC-SHA256(WORKTRACKR_SERVICE_EMAIL_SECRET, payload)  hex
//   header  = X-WT-Signature: <expiry>.<nonce>.<sig>
//
// PATH is the route path within Studio's mount — "/send", not
// "/api/service-emails/send".
//
// Env:
//   WORKTRACKR_SERVICE_EMAIL_SECRET  (required) — must match Studio's value.
//                                    Separate from IDYQ_BRIDGE_SECRET and
//                                    WORKTRACKR_BRIDGE_SECRET.
//   SWEETBYTE_BASE_URL               (required) — Studio's origin.

const crypto = require('crypto');

const SIGNATURE_TTL_SECONDS = 120;

function studioBaseUrl() {
  return String(process.env.SWEETBYTE_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * Call Studio.
 *
 * Throws only on transport failure or misconfiguration. A non-2xx response is
 * RETURNED, because Studio's 409s are meaningful answers — "already sent",
 * "suppressed" — that the salesperson needs to see rather than errors to
 * swallow.
 *
 * Returns { ok, status, json }.
 */
async function callStudio(method, path, { body, queryString } = {}) {
  const secret = process.env.WORKTRACKR_SERVICE_EMAIL_SECRET;
  if (!secret) throw new Error('WORKTRACKR_SERVICE_EMAIL_SECRET is not set');
  const base = studioBaseUrl();
  if (!base) throw new Error('SWEETBYTE_BASE_URL is not set');

  const expiry = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${expiry}.${nonce}.${method}.${path}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const url = `${base}/api/service-emails${path}${queryString ? `?${queryString}` : ''}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-WT-Signature': `${expiry}.${nonce}.${sig}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try { json = await res.json(); } catch { /* Studio returned a non-JSON error page */ }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Cancel every pending follow-up for a company.
 *
 * Called when a company moves to dead or customer — in both cases the
 * follow-up has stopped being useful, for opposite reasons.
 *
 * Never throws. This runs inside the contact save path and a failure to reach
 * Studio must not lose the user's actual save; worst case a follow-up goes out
 * that shouldn't have, and the reason is in the logs.
 */
async function cancelFollowupsForContact(contactId, reason) {
  try {
    const r = await callStudio('POST', '/cancel-followups', {
      body: { externalCompanyId: contactId, reason: reason || 'stage change' },
    });
    if (!r.ok) {
      console.error('[service-email] cancel-followups refused:', r.status, r.json && r.json.error);
    }
    return r;
  } catch (err) {
    console.error('[service-email] cancel-followups failed:', err.message);
    return { ok: false, status: 0, json: null };
  }
}

module.exports = { callStudio, cancelFollowupsForContact };
