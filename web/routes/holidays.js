// web/routes/holidays.js
// Holiday / annual-leave. Mounted at /api/holidays (authenticateToken applied at mount).
//
// Staff (any logged-in user):
//   GET    /me                      — allowance bar data + my requests
//   POST   /requests                — book/request a holiday (computes working-day count)
//   DELETE /requests/:id            — cancel my own *pending* request
//
// Manager / admin / owner / partner_admin only:
//   GET    /staff                   — every staff member with allowance + balances
//   GET    /requests?status=pending — approval queue (all staff)
//   POST   /requests/:id/approve    — approve a request
//   POST   /requests/:id/reject     — reject a request
//   PUT    /requests/:id            — edit ANY staff member's booking (dates / half
//                                     days / note). Recomputes the day count from
//                                     the BOOKING OWNER's working week, never the
//                                     manager's. Status is deliberately preserved.
//   DELETE /requests/:id            — (manager branch) delete ANY staff member's
//                                     booking outright, whatever its status
//   PUT    /allowances/:userId      — set a person's allowance / working week / carry-over
//   GET    /settings                — company holiday year + carry-over policy
//   PUT    /settings                — set company holiday year + carry-over policy
//
// All queries are org-scoped on the British column `organisation_id`.
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { query, getOrgContext } = require('@worktrackr/shared/db');

const isManager = (ctx) =>
  ctx.type === 'partner_admin' || ['admin', 'manager', 'owner'].includes(ctx.role);

const DEFAULT_WORKING = '1111100'; // Mon..Sun, Mon–Fri working

// ── working-day counter ──────────────────────────────────────────────────────
// Counts the working days between start and end (inclusive) using the person's
// working-week pattern (Mon..Sun). Half-day flags subtract 0.5 each, but only
// when that end actually lands on a working day. Returns a number ending in .0
// or .5.
function countWorkingDays(startStr, endStr, workingDays, halfStart, halfEnd) {
  const wd = (workingDays && workingDays.length === 7) ? workingDays : DEFAULT_WORKING;
  const s = new Date(`${startStr}T00:00:00Z`);
  const e = new Date(`${endStr}T00:00:00Z`);
  if (isNaN(s) || isNaN(e) || e < s) return 0;

  const idxOf = (d) => (d.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    if (wd[idxOf(cur)] === '1') count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (count <= 0) return 0;

  const sameDay = startStr === endStr;
  if (halfStart && wd[idxOf(s)] === '1') count -= 0.5;
  if (!sameDay && halfEnd && wd[idxOf(e)] === '1') count -= 0.5;

  return Math.max(0, Math.round(count * 2) / 2);
}

function mapRequest(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name || null,
    type: r.type,
    startDate: r.start_date,
    endDate: r.end_date,
    halfStart: r.half_start,
    halfEnd: r.half_end,
    days: Number(r.days),
    note: r.note || '',
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note || '',
    createdAt: r.created_at,
  };
}

async function getSettings(organizationId) {
  const r = await query('SELECT * FROM holiday_settings WHERE organisation_id = $1', [organizationId]);
  return r.rows[0] || null;
}

async function getAllowance(organizationId, userId) {
  const r = await query(
    'SELECT * FROM holiday_allowances WHERE organisation_id = $1 AND user_id = $2',
    [organizationId, userId]
  );
  return r.rows[0] || null;
}

// Build the balance summary for one user from their requests + allowance + year.
// `adjustmentsTotal` is the net of any manual entitlement overrides (+/-).
function summarise(rows, allowanceRow, settings, adjustmentsTotal = 0) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const inYear = (d) => {
    if (!settings || !settings.year_start || !settings.year_end) return true;
    const day = new Date(d);
    return day >= new Date(settings.year_start) && day <= new Date(settings.year_end);
  };

  let taken = 0, booked = 0, pending = 0;
  for (const r of rows) {
    if (!inYear(r.start_date)) continue;
    const days = Number(r.days);
    if (r.status === 'pending') pending += days;
    else if (r.status === 'approved') {
      if (new Date(r.end_date) < today) taken += days;
      else booked += days;
    }
  }
  const round = (n) => Math.round(n * 2) / 2;
  taken = round(taken); booked = round(booked); pending = round(pending);
  const adjustments = round(Number(adjustmentsTotal) || 0);

  const allowanceSet = !!(allowanceRow && allowanceRow.allowance_days != null);
  const base = allowanceSet ? Number(allowanceRow.allowance_days) : null;
  const carriedOver = allowanceRow ? Number(allowanceRow.carry_over_days || 0) : 0;
  const allowance = allowanceSet ? round(base + carriedOver + adjustments) : null;
  const remaining = allowanceSet ? round(allowance - taken - booked - pending) : null;

  return {
    allowanceSet,
    baseAllowance: base,
    carriedOver,
    adjustments,
    allowance,
    workingDays: (allowanceRow && allowanceRow.working_days) || DEFAULT_WORKING,
    taken, booked, pending, remaining,
  };
}

async function getAdjustmentsTotal(organizationId, userId) {
  const r = await query(
    'SELECT COALESCE(SUM(days),0) AS total FROM holiday_adjustments WHERE organisation_id = $1 AND user_id = $2',
    [organizationId, userId]
  );
  return Number(r.rows[0].total || 0);
}

// ── GET /me ──────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    const organizationId = ctx.organizationId;
    const settings = await getSettings(organizationId);
    const allowanceRow = await getAllowance(organizationId, req.user.userId);

    const reqs = await query(
      `SELECT * FROM holiday_requests
        WHERE organisation_id = $1 AND user_id = $2 AND status <> 'cancelled'
        ORDER BY start_date DESC`,
      [organizationId, req.user.userId]
    );

    const summary = summarise(reqs.rows, allowanceRow, settings,
      await getAdjustmentsTotal(organizationId, req.user.userId));
    res.json({
      ...summary,
      yearStart: settings ? settings.year_start : null,
      yearEnd: settings ? settings.year_end : null,
      requests: reqs.rows.map(mapRequest),
    });
  } catch (err) {
    console.error('Error fetching my holidays:', err);
    res.status(500).json({ error: 'Failed to load holidays' });
  }
});

// ── POST /requests ───────────────────────────────────────────────────────────
const requestSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  halfStart: z.boolean().optional().default(false),
  halfEnd: z.boolean().optional().default(false),
  note: z.string().optional().nullable(),
});

router.post('/requests', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    const organizationId = ctx.organizationId;
    const data = requestSchema.parse(req.body);

    if (new Date(data.endDate) < new Date(data.startDate)) {
      return res.status(400).json({ error: 'End date is before start date' });
    }

    const allowanceRow = await getAllowance(organizationId, req.user.userId);
    const workingDays = (allowanceRow && allowanceRow.working_days) || DEFAULT_WORKING;
    const days = countWorkingDays(data.startDate, data.endDate, workingDays, data.halfStart, data.halfEnd);
    if (days <= 0) {
      return res.status(400).json({ error: 'That date range has no working days for you' });
    }

    const ins = await query(
      `INSERT INTO holiday_requests
         (organisation_id, user_id, start_date, end_date, half_start, half_end, days, note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
      [organizationId, req.user.userId, data.startDate, data.endDate,
       data.halfStart, data.halfEnd, days, data.note || null]
    );
    res.status(201).json(mapRequest(ins.rows[0]));
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: err.errors });
    console.error('Error creating holiday request:', err);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// ── DELETE /requests/:id ─────────────────────────────────────────────────────
// Two behaviours in one endpoint, deliberately in this order so the existing
// staff behaviour is completely unchanged:
//   1. Anyone may cancel their OWN request while it is still 'pending'.
//   2. A manager may additionally delete ANY booking in their organisation,
//      whatever its status and whoever it belongs to (owner's choice: the row
//      is removed outright, not marked cancelled).
// A manager deleting their own pending request matches branch 1 first — same
// outcome either way.
router.delete('/requests/:id', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    const organizationId = ctx.organizationId;

    const own = await query(
      `DELETE FROM holiday_requests
        WHERE id = $1 AND organisation_id = $2 AND user_id = $3 AND status = 'pending'`,
      [req.params.id, organizationId, req.user.userId]
    );
    if (own.rowCount > 0) return res.json({ success: true });

    if (isManager(ctx)) {
      const any = await query(
        'DELETE FROM holiday_requests WHERE id = $1 AND organisation_id = $2',
        [req.params.id, organizationId]
      );
      if (any.rowCount > 0) return res.json({ success: true });
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.status(404).json({ error: 'Pending request not found' });
  } catch (err) {
    console.error('Error cancelling holiday request:', err);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// ── GET /staff  (manager) — every staff member + their balances ──────────────
router.get('/staff', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const settings = await getSettings(organizationId);

    const people = await query(
      `SELECT u.id, u.name, u.email, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = $1
        ORDER BY u.name`,
      [organizationId]
    );
    const allowances = await query('SELECT * FROM holiday_allowances WHERE organisation_id = $1', [organizationId]);
    const reqs = await query(
      `SELECT * FROM holiday_requests WHERE organisation_id = $1 AND status <> 'cancelled'`,
      [organizationId]
    );
    const allowByUser = {}; allowances.rows.forEach((a) => { allowByUser[a.user_id] = a; });
    const reqsByUser = {}; reqs.rows.forEach((r) => { (reqsByUser[r.user_id] = reqsByUser[r.user_id] || []).push(r); });
    const adjRows = await query(
      'SELECT user_id, COALESCE(SUM(days),0) AS total FROM holiday_adjustments WHERE organisation_id = $1 GROUP BY user_id',
      [organizationId]
    );
    const adjByUser = {}; adjRows.rows.forEach((a) => { adjByUser[a.user_id] = Number(a.total || 0); });

    const staff = people.rows.map((p) => {
      const summary = summarise(reqsByUser[p.id] || [], allowByUser[p.id] || null, settings, adjByUser[p.id] || 0);
      return { userId: p.id, name: p.name, email: p.email, role: p.role, ...summary };
    });
    res.json({ staff, yearStart: settings ? settings.year_start : null, yearEnd: settings ? settings.year_end : null });
  } catch (err) {
    console.error('Error fetching holiday staff:', err);
    res.status(500).json({ error: 'Failed to load staff holidays' });
  }
});

// ── GET /requests?status=  (manager) — approval queue across all staff ───────
router.get('/requests', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const params = [organizationId];
    let where = 'hr.organisation_id = $1';
    if (req.query.status) { params.push(req.query.status); where += ` AND hr.status = $${params.length}`; }
    const r = await query(
      `SELECT hr.*, u.name AS user_name
         FROM holiday_requests hr JOIN users u ON u.id = hr.user_id
        WHERE ${where}
        ORDER BY hr.start_date ASC`,
      params
    );
    res.json(r.rows.map(mapRequest));
  } catch (err) {
    console.error('Error fetching holiday requests:', err);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ── POST /requests/:id/approve | /reject  (manager) ──────────────────────────
function decide(toStatus) {
  return async (req, res) => {
    try {
      const ctx = await getOrgContext(req.user.userId);
      if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
      const organizationId = ctx.organizationId;
      const upd = await query(
        `UPDATE holiday_requests
            SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
          WHERE id = $4 AND organisation_id = $5 AND status = 'pending'
          RETURNING *`,
        [toStatus, req.user.userId, req.body?.note || null, req.params.id, organizationId]
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'Pending request not found' });
      res.json(mapRequest(upd.rows[0]));
    } catch (err) {
      console.error(`Error setting holiday request to ${toStatus}:`, err);
      res.status(500).json({ error: 'Failed to update request' });
    }
  };
}
router.post('/requests/:id/approve', decide('approved'));
router.post('/requests/:id/reject', decide('rejected'));

// ── PUT /requests/:id  (manager) — edit any staff member's booking ────────────
// The stored `days` is what every balance is calculated from, so it MUST be
// recomputed whenever the dates move — and from the working week of the person
// the booking belongs to, not the manager doing the editing. Getting that wrong
// would silently mis-state someone's remaining holiday with nothing on screen
// to hint at it.
// `status` is intentionally left alone: editing an approved booking keeps it
// approved (owner's decision) so a corrected date doesn't need re-approving.
router.put('/requests/:id', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const data = requestSchema.parse(req.body);

    const existing = await query(
      'SELECT * FROM holiday_requests WHERE id = $1 AND organisation_id = $2',
      [req.params.id, organizationId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Booking not found' });
    const row = existing.rows[0];

    if (new Date(data.endDate) < new Date(data.startDate)) {
      return res.status(400).json({ error: 'End date is before start date' });
    }

    const allowanceRow = await getAllowance(organizationId, row.user_id);
    const workingDays = (allowanceRow && allowanceRow.working_days) || DEFAULT_WORKING;
    const days = countWorkingDays(data.startDate, data.endDate, workingDays, data.halfStart, data.halfEnd);
    if (days <= 0) {
      return res.status(400).json({ error: 'That date range has no working days for this person' });
    }

    const upd = await query(
      `UPDATE holiday_requests
          SET start_date = $1, end_date = $2, half_start = $3, half_end = $4,
              days = $5, note = $6, updated_at = NOW()
        WHERE id = $7 AND organisation_id = $8
        RETURNING *`,
      [data.startDate, data.endDate, data.halfStart, data.halfEnd,
       days, data.note || null, req.params.id, organizationId]
    );
    res.json(mapRequest(upd.rows[0]));
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: err.errors });
    console.error('Error editing holiday request:', err);
    res.status(500).json({ error: 'Failed to edit booking' });
  }
});

// ── PUT /allowances/:userId  (manager) — allowance / working week / carry-over ─
const allowanceSchema = z.object({
  allowanceDays: z.number().min(0).max(366).nullable().optional(),
  carryOverDays: z.number().min(0).max(366).optional(),
  workingDays: z.string().regex(/^[01]{7}$/).optional(),
});

router.put('/allowances/:userId', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const data = allowanceSchema.parse(req.body);

    // Confirm the target user is in this org.
    const member = await query(
      'SELECT 1 FROM memberships WHERE organisation_id = $1 AND user_id = $2',
      [organizationId, req.params.userId]
    );
    if (member.rows.length === 0) return res.status(404).json({ error: 'User not in organisation' });

    const existing = await getAllowance(organizationId, req.params.userId);
    const allowanceDays = data.allowanceDays !== undefined ? data.allowanceDays
      : (existing ? existing.allowance_days : null);
    const carryOverDays = data.carryOverDays !== undefined ? data.carryOverDays
      : (existing ? Number(existing.carry_over_days || 0) : 0);
    const workingDays = data.workingDays !== undefined ? data.workingDays
      : (existing ? existing.working_days : DEFAULT_WORKING);

    await query(
      `INSERT INTO holiday_allowances (organisation_id, user_id, allowance_days, carry_over_days, working_days, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (organisation_id, user_id)
       DO UPDATE SET allowance_days = EXCLUDED.allowance_days,
                     carry_over_days = EXCLUDED.carry_over_days,
                     working_days = EXCLUDED.working_days,
                     updated_at = NOW()`,
      [organizationId, req.params.userId, allowanceDays, carryOverDays, workingDays]
    );
    const row = await getAllowance(organizationId, req.params.userId);
    res.json({
      userId: req.params.userId,
      allowanceDays: row.allowance_days != null ? Number(row.allowance_days) : null,
      carryOverDays: Number(row.carry_over_days || 0),
      workingDays: row.working_days,
    });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid allowance', details: err.errors });
    console.error('Error saving allowance:', err);
    res.status(500).json({ error: 'Failed to save allowance' });
  }
});

// ── GET/PUT /settings  (manager) — company holiday year + carry-over policy ──
router.get('/settings', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const s = await getSettings(ctx.organizationId);
    res.json(s ? {
      yearStart: s.year_start, yearEnd: s.year_end,
      carryOverAllowed: s.carry_over_allowed, carryOverMaxDays: Number(s.carry_over_max_days || 0),
    } : { yearStart: null, yearEnd: null, carryOverAllowed: false, carryOverMaxDays: 0 });
  } catch (err) {
    console.error('Error fetching holiday settings:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

const settingsSchema = z.object({
  yearStart: z.string().nullable().optional(),
  yearEnd: z.string().nullable().optional(),
  carryOverAllowed: z.boolean().optional(),
  carryOverMaxDays: z.number().min(0).max(366).optional(),
});

router.put('/settings', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const data = settingsSchema.parse(req.body);
    await query(
      `INSERT INTO holiday_settings (organisation_id, year_start, year_end, carry_over_allowed, carry_over_max_days, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (organisation_id)
       DO UPDATE SET year_start = EXCLUDED.year_start,
                     year_end = EXCLUDED.year_end,
                     carry_over_allowed = EXCLUDED.carry_over_allowed,
                     carry_over_max_days = EXCLUDED.carry_over_max_days,
                     updated_at = NOW()`,
      [organizationId, data.yearStart || null, data.yearEnd || null,
       data.carryOverAllowed ?? false, data.carryOverMaxDays ?? 0]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid settings', details: err.errors });
    console.error('Error saving holiday settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ── GET /calendar — approved holidays org-wide (any signed-in user) ──────────
// Powers the shared team calendar (Delivery + Sales). Names + dates only, no
// notes/reasons. Not gated to managers — everyone can see who's off.
router.get('/calendar', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    const r = await query(
      `SELECT hr.id, hr.user_id, hr.start_date, hr.end_date, hr.half_start, hr.half_end, hr.days, u.name AS user_name
         FROM holiday_requests hr JOIN users u ON u.id = hr.user_id
        WHERE hr.organisation_id = $1 AND hr.status = 'approved'
        ORDER BY hr.start_date ASC`,
      [ctx.organizationId]
    );
    res.json(r.rows.map((h) => ({
      id: h.id,
      userId: h.user_id,
      userName: h.user_name,
      startDate: h.start_date,
      endDate: h.end_date,
      halfStart: h.half_start,
      halfEnd: h.half_end,
      days: Number(h.days),
    })));
  } catch (err) {
    console.error('Error fetching holiday calendar:', err);
    res.status(500).json({ error: 'Failed to load holiday calendar' });
  }
});

// ── adjustments (manager) — entitlement overrides with a reason ──────────────
//   GET    /allowances/:userId/adjustments       — list a person's adjustments
//   POST   /allowances/:userId/adjustments        — add one (+/- days + reason)
//   DELETE /allowances/:userId/adjustments/:adjId — remove one
const adjustmentSchema = z.object({
  days: z.number().refine((n) => n !== 0, 'Days cannot be zero').refine((n) => Math.abs(n) <= 366, 'Out of range'),
  reason: z.string().min(1, 'A reason is required'),
});

router.get('/allowances/:userId/adjustments', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const r = await query(
      `SELECT a.*, u.name AS created_by_name
         FROM holiday_adjustments a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.organisation_id = $1 AND a.user_id = $2
        ORDER BY a.created_at DESC`,
      [ctx.organizationId, req.params.userId]
    );
    res.json(r.rows.map((a) => ({
      id: a.id, days: Number(a.days), reason: a.reason,
      createdBy: a.created_by, createdByName: a.created_by_name || null, createdAt: a.created_at,
    })));
  } catch (err) {
    console.error('Error listing adjustments:', err);
    res.status(500).json({ error: 'Failed to load adjustments' });
  }
});

router.post('/allowances/:userId/adjustments', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const organizationId = ctx.organizationId;
    const data = adjustmentSchema.parse(req.body);

    const member = await query(
      'SELECT 1 FROM memberships WHERE organisation_id = $1 AND user_id = $2',
      [organizationId, req.params.userId]
    );
    if (member.rows.length === 0) return res.status(404).json({ error: 'User not in organisation' });

    const days = Math.round(Number(data.days) * 2) / 2;
    const ins = await query(
      `INSERT INTO holiday_adjustments (organisation_id, user_id, days, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [organizationId, req.params.userId, days, data.reason, req.user.userId]
    );
    const a = ins.rows[0];
    res.status(201).json({ id: a.id, days: Number(a.days), reason: a.reason, createdAt: a.created_at });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid adjustment', details: err.errors });
    console.error('Error adding adjustment:', err);
    res.status(500).json({ error: 'Failed to add adjustment' });
  }
});

router.delete('/allowances/:userId/adjustments/:adjId', async (req, res) => {
  try {
    const ctx = await getOrgContext(req.user.userId);
    if (!isManager(ctx)) return res.status(403).json({ error: 'Manager access required' });
    const del = await query(
      'DELETE FROM holiday_adjustments WHERE id = $1 AND organisation_id = $2 AND user_id = $3',
      [req.params.adjId, ctx.organizationId, req.params.userId]
    );
    if (del.rowCount === 0) return res.status(404).json({ error: 'Adjustment not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting adjustment:', err);
    res.status(500).json({ error: 'Failed to delete adjustment' });
  }
});

module.exports = router;
