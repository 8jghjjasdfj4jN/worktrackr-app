const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { query, getOrgContext } = require('@worktrackr/shared/db');

// Validation schemas
const crmEventSchema = z.object({
  contact_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1, 'Title is required'),
  type: z.enum(['call', 'meeting', 'follow_up', 'renewal', 'other']),
  description: z.string().optional().nullable(),
  start_at: z.string(), // ISO 8601 timestamp
  end_at: z.string(), // ISO 8601 timestamp
  all_day: z.boolean().default(false),
  assigned_user_id: z.string().uuid().optional().nullable(),
  status: z.enum(['planned', 'in_progress', 'done', 'cancelled']).default('planned'),
  notes: z.string().optional().nullable()
});

// GET /api/crm-events - Get all CRM events for the organization
router.get('/', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { start_date, end_date, status, contact_id } = req.query;

    let whereClause = 'WHERE e.organisation_id = $1';
    const params = [organizationId];
    let paramCount = 1;

    if (start_date) {
      whereClause += ` AND start_at >= $${++paramCount}`;
      params.push(start_date);
    }

    if (end_date) {
      whereClause += ` AND end_at <= $${++paramCount}`;
      params.push(end_date);
    }

    if (status) {
      whereClause += ` AND status = $${++paramCount}`;
      params.push(status);
    }

    if (contact_id) {
      whereClause += ` AND contact_id = $${++paramCount}`;
      params.push(contact_id);
    }

    const result = await query(
      `SELECT 
        e.*,
        c.name as contact_name,
        c.crm->>'salesStage' as contact_sales_stage
       FROM crm_events e
       LEFT JOIN contacts c ON e.contact_id = c.id
       ${whereClause}
       ORDER BY start_at ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching CRM events:', error);
    res.status(500).json({ error: 'Failed to fetch CRM events' });
  }
});

// GET /api/crm-events/:id - Get a single CRM event
router.get('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    const result = await query(
      `SELECT 
        e.*,
        c.name as contact_name,
        c.crm->>'salesStage' as contact_sales_stage
       FROM crm_events e
       LEFT JOIN contacts c ON e.contact_id = c.id
       WHERE e.id = $1 AND e.organisation_id = $2`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CRM event not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching CRM event:', error);
    res.status(500).json({ error: 'Failed to fetch CRM event' });
  }
});

// POST /api/crm-events - Create a new CRM event
router.post('/', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const userId = req.user.userId;

    const validatedData = crmEventSchema.parse(req.body);

    const result = await query(
      `INSERT INTO crm_events (
        organisation_id,
        contact_id,
        title,
        type,
        description,
        start_at,
        end_at,
        all_day,
        assigned_user_id,
        status,
        notes,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        organizationId,
        validatedData.contact_id,
        validatedData.title,
        validatedData.type,
        validatedData.description,
        validatedData.start_at,
        validatedData.end_at,
        validatedData.all_day,
        validatedData.assigned_user_id,
        validatedData.status,
        validatedData.notes,
        userId
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error creating CRM event:', error);
    res.status(500).json({ error: 'Failed to create CRM event' });
  }
});

// PUT /api/crm-events/:id - Update a CRM event
router.put('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    const validatedData = crmEventSchema.partial().parse(req.body);

    // Build dynamic update query
    const updates = [];
    const params = [id, organizationId];
    let paramCount = 2;

    Object.entries(validatedData).forEach(([key, value]) => {
      updates.push(`${key} = $${++paramCount}`);
      params.push(value);
    });

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);

    const result = await query(
      `UPDATE crm_events 
       SET ${updates.join(', ')}
       WHERE id = $1 AND organisation_id = $2
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CRM event not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    console.error('Error updating CRM event:', error);
    res.status(500).json({ error: 'Failed to update CRM event' });
  }
});

// DELETE /api/crm-events/:id - Delete a CRM event
router.delete('/:id', async (req, res) => {
  try {
    const orgContext = await getOrgContext(req.user.userId);
    const organizationId = orgContext.organizationId;
    const { id } = req.params;

    const result = await query(
      `DELETE FROM crm_events 
       WHERE id = $1 AND organisation_id = $2
       RETURNING id`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CRM event not found' });
    }

    res.json({ message: 'CRM event deleted successfully' });
  } catch (error) {
    console.error('Error deleting CRM event:', error);
    res.status(500).json({ error: 'Failed to delete CRM event' });
  }
});

module.exports = router;
