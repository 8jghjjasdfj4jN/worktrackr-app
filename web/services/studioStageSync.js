// web/services/studioStageSync.js
//
// Push sales stages to Sweetbyte Studio.
//
// WHY THIS EXISTS
// Studio's keep-warm emails go to people who have already had the introduction
// email, EXCEPT anyone who has since gone dead or been marked contacted. Studio
// owns the address list — it sent those emails — but the sales stage lives here,
// and Studio has no way of knowing it changed.
//
// WHY WE PUSH RATHER THAN LET STUDIO PULL
// Purely because this direction already works. WorkTrackr has been calling
// Studio since the service-email panel shipped: SWEETBYTE_BASE_URL and
// WORKTRACKR_SERVICE_EMAIL_SECRET are set, the signing helper is written and
// proven. Pointing a second connection the other way would mean a base URL and
// an organisation id configured on two more services, and every one of those is
// a thing that can be wrong at three in the morning. Reusing the working
// direction needs no new configuration at all.
//
// TENANCY — READ BEFORE CHANGING
// There is no user on a background push, so nothing in the request says which
// organisation this is about. The scope is derived instead: the organisations
// that appear in `service_email_sends`, which is by definition the set that
// uses the Studio integration. A tenant that has never sent a service email is
// never included, so no other customer's contacts can reach Sweetbyte's Studio.
// Do not widen this query to "all contacts" for convenience.
//
// STAGE CHANGES ARE PUSHED IMMEDIATELY, AND RECONCILED ON A TIMER
// The immediate push is what makes a company going dead stop the emails today
// rather than within the half hour. The timer is what makes a push lost to a
// deploy or a network blip self-correct, because a stale stage in Studio means
// mailing somebody who asked to be left alone — and a system that only ever
// pushes is exactly as correct as its last successful push.
//
// NEVER THROWS. This runs inside the contact save path and on a background
// timer. A failure to reach Studio must not lose somebody's save or kill the
// process; it logs and moves on.

const { query } = require('@worktrackr/shared/db');
const { callStudio } = require('./serviceEmailBridge');

// Half an hour. Short enough that a missed push is corrected well inside the
// fortnightly send cycle, long enough that it is not chatter.
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;

let timer = null;
let lastResult = null;

/**
 * Organisations that use the Studio integration.
 *
 * Optional override for the edge case of a fresh environment where nobody has
 * sent a service email yet and the derived list is therefore empty. Not needed
 * in normal operation and deliberately not documented as a required variable.
 */
async function integratedOrgIds() {
  const override = String(process.env.STUDIO_STAGE_SYNC_ORG_ID || '').trim();
  if (override) return [override];

  const r = await query('SELECT DISTINCT organisation_id FROM service_email_sends');
  return r.rows.map((x) => String(x.organisation_id));
}

function mapRow(r) {
  return {
    id: String(r.id),
    name: r.name || null,
    primaryContact: r.primary_contact || null,
    stage: r.sales_stage || null,
  };
}

/**
 * Send every company in the integrated organisations, with its stage as it
 * stands right now.
 *
 * Marked as a snapshot so Studio knows the payload is complete for these
 * companies and can clear the stage on anything it holds that is no longer
 * here — a contact deleted in WorkTrackr otherwise keeps whatever stage it had
 * on the day it vanished, and keeps receiving email forever on the strength of
 * it. Studio treats a cleared stage as "no stage", which is excluded by
 * default, so a deletion fails safe.
 */
async function pushAllStages(reason = 'reconcile') {
  try {
    const orgIds = await integratedOrgIds();
    if (orgIds.length === 0) {
      console.log('[stage-sync] no organisations found in service_email_sends — nothing to push');
      lastResult = { ok: true, count: 0, at: new Date().toISOString(), note: 'no integrated orgs' };
      return lastResult;
    }

    const r = await query(
      `SELECT id, name, primary_contact, crm->>'salesStage' AS sales_stage
         FROM contacts
        WHERE organisation_id = ANY($1::uuid[])`,
      [orgIds]
    );

    const companies = r.rows.map(mapRow);

    const res = await callStudio('POST', '/stages', {
      body: { snapshot: true, reason, companies },
    });

    if (!res.ok) {
      console.error('[stage-sync] Studio refused the snapshot:', res.status, res.json && res.json.error);
      lastResult = { ok: false, count: companies.length, error: (res.json && res.json.error) || `HTTP ${res.status}` };
      return lastResult;
    }

    console.log(`[stage-sync] pushed ${companies.length} companies to Studio (${reason})`);
    lastResult = { ok: true, count: companies.length, at: new Date().toISOString() };
    return lastResult;
  } catch (err) {
    console.error('[stage-sync] snapshot push failed:', err.message);
    lastResult = { ok: false, error: err.message };
    return lastResult;
  }
}

/**
 * Send one company, immediately, because somebody just changed its stage.
 *
 * NOT a snapshot — a single-company payload says nothing about the companies
 * it omits, and Studio must not read this as permission to clear the rest.
 *
 * Fired on EVERY stage change, not only dead and customer. The keep-warm
 * audience is defined by which stages are in it, so a move from contacted to
 * prospect adds somebody to the loop just as a move to dead removes them, and
 * both need to reach Studio.
 */
async function pushOneStage(contactId, reason = 'stage change') {
  try {
    const r = await query(
      `SELECT id, name, primary_contact, crm->>'salesStage' AS sales_stage
         FROM contacts
        WHERE id = $1`,
      [contactId]
    );
    if (r.rows.length === 0) return { ok: false, error: 'contact not found' };

    const res = await callStudio('POST', '/stages', {
      body: { snapshot: false, reason, companies: [mapRow(r.rows[0])] },
    });

    if (!res.ok) {
      console.error('[stage-sync] Studio refused a stage update:', res.status, res.json && res.json.error);
      return { ok: false, error: (res.json && res.json.error) || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[stage-sync] single push failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Start the reconcile timer.
 *
 * First run is delayed a minute so it does not compete with everything else a
 * cold start is doing, and so a crash-looping deploy does not hammer Studio.
 */
function startStageSync() {
  if (timer) return;
  console.log(`[stage-sync] starting — reconcile every ${RECONCILE_INTERVAL_MS / 60000} minutes`);
  setTimeout(() => {
    pushAllStages('startup');
    timer = setInterval(() => pushAllStages('reconcile'), RECONCILE_INTERVAL_MS);
  }, 60 * 1000);
}

function lastStageSyncResult() {
  return lastResult;
}

module.exports = { pushAllStages, pushOneStage, startStageSync, lastStageSyncResult };
