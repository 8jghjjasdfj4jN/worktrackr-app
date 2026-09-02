const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { query, getOrgContext } = require('@worktrackr/shared/db');
const { cancelFollowupsForContact } = require('../services/serviceEmailBridge');

// Validation schemas
const contactSchema = z.object({
  type: z.enum(['company', 'individual']).default('company'),
  name: z.string().min(1, 'Name is required'),
  displayName: z.string().optional(),
  primaryContact: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
  addresses: z.array(z.any()).default([]),
  accounting: z.object({
    xeroContactId: z.string().optional().nullable(),
    quickbooksContactId: z.string().optional().nullable(),
    taxNumber: z.string().optional(),
    paymentTerms: z.string().optional(),
    currency: z.string().default('GBP'),
    accountCode: z.string().optional(),
    creditLimit: z.number().optional().default(0),
    discountRate: z.number().optional().default(0)
  }).optional().default({}),
  crm: z.object({
    status: z.enum(['active', 'inactive', 'at_risk', 'prospect', 'archived']).default('prospect'),
    // Sales pipeline stage (Phase 1) — kept separate from `status` (customer health).
    // Suspect (value 'new') → Contacted → Prospect → Hot Prospect → Customer.
    salesStage: z.enum(['new', 'contacted', 'voicemail', 'prospect', 'hot_prospect', 'customer', 'dead']).optional().nullable(), // null = back to "No stage"
    // Leads workflow fields (stored on the company's crm JSONB, like salesStage).
    firstContact: z.string().optional().nullable(),   // date first actually spoke (yyyy-mm-dd)
    chaseDate: z.string().optional().nullable(),       // date to next chase (yyyy-mm-dd)
    nextAction: z.string().optional(),                 // free text, e.g. "Call back"
    archived: z.boolean().optional().default(false),   // archived leads are hidden from salesmen
    archivedAt: z.string().optional().nullable(),
    lastActivity: z.string().optional().nullable(),
    nextCRMEvent: z.string().optional().nullable(),
    renewalsCount: z.number().optional().default(0),
    openOppsCount: z.number().optional().default(0),
    totalProfit: z.number().optional().default(0),
    assignedTo: z.string().optional().nullable(),
    spotterUserId: z.string().uuid().optional().nullable(), // who spotted/found this company (sales)
    source: z.string().optional(),
    industry: z.string().optional(),
    companySize: z.string().optional()
  }).optional().default({}),
  contactPersons: z.array(z.any()).default([]),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  customFields: z.object({}).optional().default({})
}).strict(false);

// ─── Response normaliser ───────────────────────────────────────────────────────
// DB columns are snake_case; the frontend expects camelCase throughout.
// Every row returned from the DB must pass through this before being sent to
// the client, otherwise:
//   1. Edit forms open with blank fields (contact.primaryContact = undefined)
//   2. contactPersons gets silently wiped to [] on every save because
//      JSON.stringify omits undefined, Zod's default([]) fills it, and the
//      UPDATE then writes contact_persons = '[]' to the DB.
function mapContact(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    displayName: row.display_name || '',
    primaryContact: row.primary_contact || '',
    email: row.email || '',
    phone: row.phone || '',
    website: row.website || '',
    addresses: row.addresses || [],
    accounting: row.accounting || {},
    crm: row.crm || {},
    contactPersons: row.contact_persons || [],
    tags: row.tags || [],
    notes: row.notes || '',
    customFields: row.custom_fields || {},
    organisationId: row.organisation_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Next diary entry for this company, attached by the list query below.
    // Undefined on endpoints that don't join it — the UI treats that the same
    // as "nothing booked", so no screen breaks.
    nextEvent: row.next_event_at
      ? {
          title: row.next_event_title || '',
          at: row.next_event_at,
          type: row.next_event_type || null,
          // Worked out in SQL against NOW() rather than in the browser, so a
          // wrong clock on someone's PC can't mark things overdue.
          overdue: row.next_event_overdue === true,
        }
      : null,
  };
}

// GET /api/contacts - Get all contacts for the organization
// Optional filters: ?type=company|individual  ?stage=new|contacted|voicemail|prospect|hot_prospect|customer
router.get('/', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;

    // ⚠️ Every condition MUST be qualified with `contacts.`. The query below
    // LEFT JOIN LATERALs the next diary entry, so the outer query has two
    // tables in scope. An unqualified `"type"` matches a column on BOTH
    // contacts and the joined entry, which Postgres rejects as ambiguous and
    // fails the WHOLE list with a 500 — exactly what happened on the first
    // attempt at this.
    const conditions = ['contacts.organisation_id = $1'];
    const params = [organizationId];
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`contacts."type" = $${params.length}`);
    }
    if (req.query.stage) {
      params.push(req.query.stage);
      conditions.push(`contacts.crm->>'salesStage' = $${params.length}`);
    }

    // Archive visibility: archived records are hidden from everyone by default;
    // only managers/admins can request the archived set (?archived=only).
    const role = orgContext.role;
    const isManager = ['admin', 'manager', 'owner', 'partner_admin'].includes(role);
    if (req.query.archived === 'only') {
      if (!isManager) return res.json([]); // non-managers never see archived
      conditions.push(`contacts.crm->>'archived' = 'true'`);
    } else {
      conditions.push(`(contacts.crm->>'archived' IS DISTINCT FROM 'true')`);
    }

    // Attach each company's NEXT diary entry so the Companies list can show
    // what's booked without opening the record.
    //
    // Only entries that are still outstanding count (planned / in progress) —
    // something already done or cancelled is not "what happens next".
    //
    // Pick order: the soonest UPCOMING entry wins. If there is nothing
    // upcoming, the most recent MISSED one is shown instead (flagged overdue),
    // so a forgotten call-back surfaces rather than silently disappearing.
    //   (e.start_at >= NOW()) DESC   -> upcoming before overdue
    //   CASE ... END ASC             -> among upcoming, soonest first
    //   e.start_at DESC              -> among overdue, most recent first
    //
    // LEFT JOIN LATERAL so companies with nothing booked still appear.
    // Conditions below use bare column names, which still resolve to contacts:
    // crm_events only exists inside the subquery, under the alias e.
    const result = await query(
      `SELECT contacts.*,
              ne.event_title      AS next_event_title,
              ne.event_start_at   AS next_event_at,
              ne.event_type       AS next_event_type,
              ne.event_is_overdue AS next_event_overdue
         FROM contacts
         LEFT JOIN LATERAL (
           SELECT e.title       AS event_title,
                  e.start_at    AS event_start_at,
                  e.type        AS event_type,
                  (e.start_at < NOW()) AS event_is_overdue
             FROM crm_events e
            WHERE e.contact_id = contacts.id
              AND e.organisation_id = contacts.organisation_id
              AND e.status IN ('planned', 'in_progress')
            ORDER BY (e.start_at >= NOW()) DESC,
                     CASE WHEN e.start_at >= NOW() THEN e.start_at END ASC,
                     e.start_at DESC
            LIMIT 1
         ) ne ON TRUE
        WHERE ${conditions.join(' AND ')}
        ORDER BY contacts.created_at DESC`,
      params
    );

    res.json(result.rows.map(mapContact));
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/statistics - Get contact statistics
router.get('/statistics', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;

    const result = await query(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE (crm->>'status')::text = 'active') as active,
        COUNT(*) FILTER (WHERE (crm->>'status')::text = 'prospect') as prospects,
        COUNT(*) FILTER (WHERE (crm->>'status')::text = 'at_risk') as "atRisk",
        COUNT(*) FILTER (WHERE "type" = 'company') as companies,
        COUNT(*) FILTER (WHERE "type" = 'individual') as individuals,
        COALESCE(SUM((crm->>'totalProfit')::numeric), 0) as "totalProfit",
        COALESCE(SUM((crm->>'renewalsCount')::numeric), 0) as "totalRenewals",
        COALESCE(SUM((crm->>'openOppsCount')::numeric), 0) as "totalOpportunities"
       FROM contacts WHERE organisation_id = $1`,
      [organizationId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching contact statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// POST /api/contacts/call-log — record one call. Fired when a phone number is
// clicked to dial (phase14_call_log).
//
// Owner's rule: EVERY click is one call, including clicking the same number
// again. There is deliberately NO de-duplication — a redial after no answer is
// a real second attempt, and silently swallowing it is what made the old
// stage-based counter read low.
//
// ⚠️ MUST be declared BEFORE router.get('/:id')/router.post is fine, but it is
// kept here beside call-count for clarity.
router.post('/call-log', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const contactId = req.body && req.body.contactId ? String(req.body.contactId) : null;
    const phone = req.body && req.body.phone ? String(req.body.phone).slice(0, 64) : null;

    await query(
      `INSERT INTO contact_calls (organisation_id, contact_id, user_id, phone)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, contactId, req.user.userId, phone]
    );
    res.json({ success: true });
  } catch (error) {
    // Never let bookkeeping interfere with the user actually placing the call.
    // The dial happens in the browser regardless of what this returns.
    console.error('Could not record call:', error);
    res.status(200).json({ success: false });
  }
});

// GET /api/contacts/call-count — how many calls the WHOLE ORGANISATION has
// made today, counted as click-to-dial events (phase14_call_log).
//
// ⚠️ Sales-stage changes NO LONGER feed this number (owner's decision):
// plenty of calls never move the stage, so the old count under-reported.
// phase13's stage log still records quietly in the background so the history
// isn't lost, but nothing here reads it.
//
// Organisation-wide by design (owner's choice): anyone's call updates the
// number. Still scoped to the caller's organisation, so one company can never
// see another's activity. Reaching this at all requires Sales access, which is
// already permission-gated (user_sales_permissions), so this exposes nothing
// to someone who couldn't already see the companies themselves. No money or
// commission figures are involved.
//
// ⚠️ MUST be declared BEFORE router.get('/:id') or Express matches '/:id'
// first and treats "call-count" as a contact id.
//
// ⚠️ Counted per LONDON calendar day, never per UTC day. The server and
// database run on UTC, so between late March and late October a call made at
// 00:30 British Summer Time is still "yesterday" in UTC. Doing this in SQL
// with AT TIME ZONE lets Postgres handle the clock changes rather than
// arithmetic here getting it subtly wrong twice a year.
router.get('/call-count', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;

    const result = await query(
      `SELECT
         COUNT(*) FILTER (
           WHERE (called_at AT TIME ZONE 'Europe/London')::date
                 = (NOW() AT TIME ZONE 'Europe/London')::date
         ) AS today,
         COUNT(*) FILTER (
           WHERE (called_at AT TIME ZONE 'Europe/London')::date
                 = ((NOW() AT TIME ZONE 'Europe/London')::date - INTERVAL '1 day')
         ) AS yesterday,
         COUNT(*) FILTER (
           WHERE (called_at AT TIME ZONE 'Europe/London')::date
                 > ((NOW() AT TIME ZONE 'Europe/London')::date - INTERVAL '7 days')
         ) AS last7
       FROM contact_calls
       WHERE organisation_id = $1`,
      [organizationId]
    );

    const row = result.rows[0] || {};
    res.json({
      today: Number(row.today || 0),
      yesterday: Number(row.yesterday || 0),
      last7: Number(row.last7 || 0),
    });
  } catch (error) {
    // The table may not exist yet on an instance that hasn't run phase13.
    // Report zeroes rather than breaking the Sales page over a counter.
    console.error('Error fetching call count:', error);
    res.json({ today: 0, yesterday: 0, last7: 0, unavailable: true });
  }
});

// GET /api/contacts/:id - Get a single contact
router.get('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    const result = await query(
      `SELECT * FROM contacts WHERE id = $1 AND organisation_id = $2`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(mapContact(result.rows[0]));
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// GET /api/contacts/:id/history - activity timeline for a company
// Aggregates CRM events (calls, meetings, etc.) and completed tasks, newest first.
router.get('/:id/history', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const { id } = req.params;

    const events = await query(
      `SELECT e.id, e.type, e.title, e.start_at AS at, u.name AS actor
         FROM crm_events e
         LEFT JOIN users u ON u.id = COALESCE(e.created_by, e.assigned_user_id)
        WHERE e.contact_id = $1 AND e.organisation_id = $2`,
      [id, organizationId]
    );

    const doneTasks = await query(
      `SELECT t.id, t.title, t.completed_at AS at, u.name AS actor
         FROM tasks t
         LEFT JOIN users u ON u.id = COALESCE(t.assigned_user_id, t.created_by)
        WHERE t.contact_id = $1 AND t.organisation_id = $2 AND t.status = 'done'`,
      [id, organizationId]
    );

    // Notes + logged emails (own store; also shown on the profile timeline).
    // Wrapped so a missing table (pre-migration) never breaks history.
    let noteRows = [];
    try {
      const notes = await query(
        `SELECT n.id, n.kind, n.subject, n.body, n.created_at AS at,
                n.updated_at, u.name AS actor, eu.name AS editor
           FROM contact_notes n
           LEFT JOIN users u  ON u.id  = n.created_by
           LEFT JOIN users eu ON eu.id = n.updated_by
          WHERE n.contact_id = $1 AND n.organisation_id = $2`,
        [id, organizationId]
      );
      noteRows = notes.rows;
    } catch (e) {
      noteRows = [];
    }

    const items = [
      ...events.rows.map((r) => ({ id: `e_${r.id}`, kind: r.type || 'other', title: r.title, actor: r.actor || null, at: r.at })),
      ...doneTasks.rows.map((r) => ({ id: `t_${r.id}`, kind: 'task', title: r.title, actor: r.actor || null, at: r.at })),
      ...noteRows.map((r) => ({
        id: `n_${r.id}`,
        kind: r.kind,
        title: r.kind === 'email' ? (r.subject || 'Email') : (r.body || ''),
        body: r.body || '',
        subject: r.subject || '',
        actor: r.actor || null,
        at: r.at,
        // present only if the note has been edited — lets the timeline say so
        editedAt: r.updated_at || null,
        editor: r.editor || null,
      })),
    ]
      .filter((x) => x.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 50);

    res.json(items);
  } catch (error) {
    console.error('Error fetching contact history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// POST /api/contacts/:id/notes - add a note or logged email to a company.
// Body: { kind?: 'note'|'email', body?, subject? }. Appears in the timeline.
router.post('/:id/notes', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const { id } = req.params;
    const kind = req.body?.kind === 'email' ? 'email' : 'note';
    const body = String(req.body?.body || '').trim();
    const subject = String(req.body?.subject || '').trim();
    if (!body && !subject) return res.status(400).json({ error: 'Nothing to save' });

    const r = await query(
      `INSERT INTO contact_notes (organisation_id, contact_id, kind, subject, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [organizationId, id, kind, subject || null, body, req.user.userId]
    );
    res.status(201).json({ id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (error) {
    console.error('Error adding contact note:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// PUT /api/contacts/:id/notes/:noteId — edit an existing note.
// Body: { body?, subject? }.
// Anyone in the organisation may edit any note (owner's decision — sales work
// as a shared log, and a colleague correcting a typo shouldn't need a manager).
// Scoped by organisation_id AND contact_id so a note can only ever be edited
// through the company it belongs to. Records who changed it and when, which is
// what the timeline uses to show an "edited" marker.
router.put('/:id/notes/:noteId', async (req, res) => {
  try {
    const { organizationId } = await getOrgContext(req.user.userId);
    const { id, noteId } = req.params;

    const parsed = z.object({
      body: z.string().max(20000).optional(),
      subject: z.string().max(500).optional().nullable(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

    const body = (parsed.data.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'A note cannot be empty' });

    const r = await query(
      `UPDATE contact_notes
          SET body = $1,
              subject = COALESCE($2, subject),
              updated_at = NOW(),
              updated_by = $3
        WHERE id = $4 AND contact_id = $5 AND organisation_id = $6
      RETURNING id, body, subject, created_at, updated_at`,
      [body, parsed.data.subject ?? null, req.user.userId, noteId, id, organizationId]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json({ note: r.rows[0] });
  } catch (error) {
    console.error('Error updating contact note:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});
// Body: { type: 'company'|'individual', rows: [{name,email,phone,primaryContact,website,notes,salesStage}] }
// Skips duplicates by name or email (against existing org contacts and within the file).
router.post('/import', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const type = req.body?.type === 'individual' ? 'individual' : 'company';
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows (max 5000)' });

    // Duplicate matching keys: name, email (exact), website/email DOMAIN, and
    // phone (digits-only, UK-aware). MUST mirror the helpers in the client's
    // CsvImport.jsx so the preview count and the actual import agree.
    const GENERIC_EMAIL_DOMAINS = new Set([
      'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.co.uk',
      'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com',
      'me.com', 'mac.com', 'btinternet.com', 'btconnect.com', 'sky.com', 'virginmedia.com',
      'talktalk.net', 'msn.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.co.uk', 'mail.com', 'yandex.com',
    ]);
    const domainFromWebsite = (website) => {
      let s = String(website || '').trim().toLowerCase();
      if (!s) return '';
      s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
      s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].trim().replace(/\.+$/, '');
      return s.includes('.') ? s : '';
    };
    const domainFromEmail = (email) => {
      const s = String(email || '').trim().toLowerCase();
      const at = s.lastIndexOf('@');
      if (at < 0) return '';
      const d = s.slice(at + 1).trim();
      return (d.includes('.') && !GENERIC_EMAIL_DOMAINS.has(d)) ? d : '';
    };
    const domainsOf = (website, email) => {
      const arr = [];
      const w = domainFromWebsite(website);
      if (w) arr.push(w);
      const e = domainFromEmail(email);
      if (e && e !== w) arr.push(e);
      return arr;
    };
    const phoneKey = (phone) => {
      let d = String(phone || '').replace(/\D/g, '');
      if (!d) return '';
      if (d.startsWith('0044')) d = `0${d.slice(4)}`;
      else if (d.startsWith('44') && d.length >= 11) d = `0${d.slice(2)}`;
      if (d.length === 10 && /^[123789]/.test(d)) d = `0${d}`;
      return d.length >= 10 ? d : '';
    };

    const existing = await query('SELECT lower(name) AS name, lower(email) AS email, website, phone FROM contacts WHERE organisation_id = $1', [organizationId]);
    const haveName = new Set(existing.rows.map((r) => r.name).filter(Boolean));
    const haveEmail = new Set(existing.rows.map((r) => r.email).filter(Boolean));
    const haveDomain = new Set();
    const havePhone = new Set();
    for (const r of existing.rows) {
      domainsOf(r.website, r.email).forEach((d) => haveDomain.add(d));
      const pk = phoneKey(r.phone);
      if (pk) havePhone.add(pk);
    }
    const seenName = new Set();
    const seenEmail = new Set();
    const seenDomain = new Set();
    const seenPhone = new Set();
    const VALID_STAGES = ['new', 'contacted', 'voicemail', 'prospect', 'hot_prospect', 'customer', 'dead'];

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const name = String(row.name || '').trim();
      const email = String(row.email || '').trim();
      const emailKey = email.toLowerCase();
      const nameKey = name.toLowerCase();
      if (!name) { errors.push({ row: i + 1, error: 'Missing name' }); continue; }
      const domKeys = domainsOf(row.website, email);
      const phKey = phoneKey(row.phone);
      const dup = haveName.has(nameKey)
        || (emailKey && haveEmail.has(emailKey))
        || domKeys.some((d) => haveDomain.has(d) || seenDomain.has(d))
        || (phKey && (havePhone.has(phKey) || seenPhone.has(phKey)))
        || seenName.has(nameKey)
        || (emailKey && seenEmail.has(emailKey));
      if (dup) { skipped++; continue; }
      seenName.add(nameKey);
      if (emailKey) seenEmail.add(emailKey);
      domKeys.forEach((d) => seenDomain.add(d));
      if (phKey) seenPhone.add(phKey);

      const crm = {};
      let stage = String(row.salesStage || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (stage === 'suspect') stage = 'new'; // legacy alias from older imports/spreadsheets
      if (VALID_STAGES.includes(stage)) crm.salesStage = stage;
      const industry = String(row.industry || '').trim();
      if (industry) crm.industry = industry;
      const employees = String(row.employees || '').trim();
      if (employees) crm.companySize = employees;
      // Address is stored on the contact's `addresses` JSONB array (one entry).
      const address = String(row.address || '').trim();
      const addresses = address ? [address] : [];

      try {
        await query(
          `INSERT INTO contacts (organisation_id, "type", name, display_name, primary_contact, email, phone, website, addresses, crm, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [organizationId, type, name, name, String(row.primaryContact || ''), email, String(row.phone || ''), String(row.website || ''), JSON.stringify(addresses), JSON.stringify(crm), String(row.notes || ''), req.user.userId]
        );
        created++;
      } catch (e) {
        errors.push({ row: i + 1, error: 'Could not save' });
      }
    }

    res.json({ created, skipped, errors, total: rows.length });
  } catch (error) {
    console.error('Error importing contacts:', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

router.post('/', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;

    const validatedData = contactSchema.parse(req.body);

    const result = await query(
      `INSERT INTO contacts (
        organisation_id, "type", name, display_name, primary_contact, email, phone, website,
        addresses, accounting, crm, contact_persons, tags, notes, custom_fields, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        organizationId,
        validatedData.type,
        validatedData.name,
        validatedData.displayName || validatedData.name,
        validatedData.primaryContact || '',
        validatedData.email || '',
        validatedData.phone || '',
        validatedData.website || '',
        JSON.stringify(validatedData.addresses),
        JSON.stringify(validatedData.accounting),
        JSON.stringify(validatedData.crm),
        JSON.stringify(validatedData.contactPersons),
        validatedData.tags,
        validatedData.notes || '',
        JSON.stringify(validatedData.customFields),
        req.user.userId
      ]
    );

    res.status(201).json(mapContact(result.rows[0]));
  } catch (error) {
    console.error('Error creating contact:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PUT /api/contacts/:id - Update a contact
router.put('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    // Verify contact exists and belongs to organization.
    // `crm` is selected too so the sales stage BEFORE this save is known — it
    // is the only way to tell whether this request actually changes the stage
    // (the whole crm object is replaced on save, not merged).
    const checkResult = await query(
      `SELECT id, crm FROM contacts WHERE id = $1 AND organisation_id = $2`,
      [id, organizationId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Parse with Zod, then strip any keys absent from the request body.
    // Without this, Zod's .default([]) / .default({}) silently fills absent
    // array/object fields, causing the UPDATE to overwrite real DB data
    // (e.g. contactPersons → [] wipes all contact people on every save).
    const presentKeys = new Set(Object.keys(req.body));
    const parsedFull = contactSchema.partial().parse(req.body);
    const validatedData = {};
    for (const key of Object.keys(parsedFull)) {
      if (presentKeys.has(key)) validatedData[key] = parsedFull[key];
    }

    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;

    if (validatedData.type !== undefined) {
      updateFields.push(`"type" = $${paramIndex++}`);
      updateValues.push(validatedData.type);
    }
    if (validatedData.name !== undefined) {
      updateFields.push(`name = $${paramIndex++}`);
      updateValues.push(validatedData.name);
    }
    if (validatedData.displayName !== undefined) {
      updateFields.push(`display_name = $${paramIndex++}`);
      updateValues.push(validatedData.displayName);
    }
    if (validatedData.primaryContact !== undefined) {
      updateFields.push(`primary_contact = $${paramIndex++}`);
      updateValues.push(validatedData.primaryContact);
    }
    if (validatedData.email !== undefined) {
      updateFields.push(`email = $${paramIndex++}`);
      updateValues.push(validatedData.email);
    }
    if (validatedData.phone !== undefined) {
      updateFields.push(`phone = $${paramIndex++}`);
      updateValues.push(validatedData.phone);
    }
    if (validatedData.website !== undefined) {
      updateFields.push(`website = $${paramIndex++}`);
      updateValues.push(validatedData.website);
    }
    if (validatedData.addresses !== undefined) {
      updateFields.push(`addresses = $${paramIndex++}`);
      updateValues.push(JSON.stringify(validatedData.addresses));
    }
    if (validatedData.accounting !== undefined) {
      updateFields.push(`accounting = $${paramIndex++}`);
      updateValues.push(JSON.stringify(validatedData.accounting));
    }
    if (validatedData.crm !== undefined) {
      updateFields.push(`crm = $${paramIndex++}`);
      updateValues.push(JSON.stringify(validatedData.crm));
    }
    if (validatedData.contactPersons !== undefined) {
      updateFields.push(`contact_persons = $${paramIndex++}`);
      updateValues.push(JSON.stringify(validatedData.contactPersons));
    }
    if (validatedData.tags !== undefined) {
      updateFields.push(`tags = $${paramIndex++}`);
      updateValues.push(validatedData.tags);
    }
    if (validatedData.notes !== undefined) {
      updateFields.push(`notes = $${paramIndex++}`);
      updateValues.push(validatedData.notes);
    }
    if (validatedData.customFields !== undefined) {
      updateFields.push(`custom_fields = $${paramIndex++}`);
      updateValues.push(JSON.stringify(validatedData.customFields));
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updateValues.push(id, organizationId);

    const result = await query(
      `UPDATE contacts SET ${updateFields.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex++} AND organisation_id = $${paramIndex++}
       RETURNING *`,
      updateValues
    );

    // Record a stage change so calls can be counted (phase13_stage_changes).
    // Only written when the stage GENUINELY differs from what was stored —
    // saving a phone number or a note must not look like a call.
    // NULL on either side is a real value meaning "No stage", not a missing
    // one, so clearing a stage and setting a first stage both count.
    // Wrapped in its own try/catch on purpose: this is bookkeeping, and a
    // failure here must never lose the user's actual save. Worst case the
    // counter is one short and the reason is in the logs.
    try {
      if (validatedData.crm !== undefined) {
        const before = checkResult.rows[0].crm || {};
        const prevStage = before.salesStage || null;
        const nextStage = (validatedData.crm && validatedData.crm.salesStage) || null;
        if (prevStage !== nextStage) {
          await query(
            `INSERT INTO contact_stage_changes
               (organisation_id, contact_id, user_id, from_stage, to_stage)
             VALUES ($1, $2, $3, $4, $5)`,
            [organizationId, id, req.user.userId, prevStage, nextStage]
          );

          // Moving to dead or customer kills any pending service-email
          // follow-up. Opposite reasons, same conclusion: a dead company
          // shouldn't be chased, and a customer shouldn't get a cold-call
          // follow-up about services they've just bought.
          //
          // Deliberately not awaited. Studio is a separate service and a slow
          // or unreachable one must not hold up the user's save; the bridge
          // swallows its own errors and logs them.
          if (nextStage === 'dead' || nextStage === 'customer') {
            cancelFollowupsForContact(id, `moved to ${nextStage} stage`);
          }
        }
      }
    } catch (logErr) {
      console.error('Could not record stage change (contact still saved):', logErr);
    }

    res.json(mapContact(result.rows[0]));
  } catch (error) {
    console.error('Error updating contact:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id - Delete a contact
router.delete('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    const result = await query(
      `DELETE FROM contacts WHERE id = $1 AND organisation_id = $2 RETURNING id`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ message: 'Contact deleted successfully', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
