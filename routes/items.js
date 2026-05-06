const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hasFullAccess, getTierLimits } = require('../middleware/tier');

// All routes require authentication
router.use(requireAuth);


// ── GET /api/items ──
// Returns user's active items, grouped by type
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, label, type, default_value, sort_order, active
       FROM items
       WHERE user_id = $1 AND active = TRUE
       ORDER BY type, sort_order, id`,
      [req.user.id]
    );

    return res.json({ items: result.rows });
  } catch (err) {
    console.error('Get items error:', err.message);
    return res.status(500).json({ error: 'Failed to load items.' });
  }
});


// ── POST /api/items ──
// Create a new item
router.post('/', async (req, res) => {
  try {
    const { label, type, defaultValue } = req.body;

    // Validate
    if (!label || !type || !defaultValue) {
      return res.status(400).json({ error: 'Label, type, and default value are required.' });
    }
    if (!['filler', 'emptier'].includes(type)) {
      return res.status(400).json({ error: 'Type must be filler or emptier.' });
    }
    if (typeof defaultValue !== 'number' || defaultValue < 1 || defaultValue > 50) {
      return res.status(400).json({ error: 'Default value must be between 1 and 50.' });
    }
    if (label.length > 60) {
      return res.status(400).json({ error: 'Label must be 60 characters or less.' });
    }

    // Check item count limit for free tier
    if (!hasFullAccess(req.user)) {
      const limits = await getTierLimits();
      const countResult = await queryOne(
        'SELECT COUNT(*) AS count FROM items WHERE user_id = $1 AND active = TRUE',
        [req.user.id]
      );
      if (parseInt(countResult.count) >= limits.maxItemsFree) {
        return res.status(403).json({
          error: `Free accounts are limited to ${limits.maxItemsFree} items. Upgrade for unlimited items.`,
          upgrade: true,
        });
      }
    }

    // Get next sort order
    const maxSort = await queryOne(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM items WHERE user_id = $1 AND type = $2',
      [req.user.id, type]
    );

    const result = await queryOne(
      `INSERT INTO items (user_id, label, type, default_value, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, label, type, default_value, sort_order, active`,
      [req.user.id, label.trim(), type, defaultValue, maxSort.next]
    );

    return res.status(201).json({ item: result });
  } catch (err) {
    console.error('Create item error:', err.message);
    return res.status(500).json({ error: 'Failed to create item.' });
  }
});


// ── PUT /api/items/:id ──
// Update an item's label, default value, or sort order
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { label, defaultValue, sortOrder } = req.body;

    // Verify ownership
    const item = await queryOne(
      'SELECT id FROM items WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (label !== undefined) {
      if (label.length > 60) {
        return res.status(400).json({ error: 'Label must be 60 characters or less.' });
      }
      updates.push(`label = $${idx++}`);
      values.push(label.trim());
    }
    if (defaultValue !== undefined) {
      if (typeof defaultValue !== 'number' || defaultValue < 1 || defaultValue > 50) {
        return res.status(400).json({ error: 'Default value must be between 1 and 50.' });
      }
      updates.push(`default_value = $${idx++}`);
      values.push(defaultValue);
    }
    if (sortOrder !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(sortOrder);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    values.push(id);
    await query(
      `UPDATE items SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Update item error:', err.message);
    return res.status(500).json({ error: 'Failed to update item.' });
  }
});


// ── DELETE /api/items/:id ──
// Soft delete (set active = false)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'UPDATE items SET active = FALSE WHERE id = $1 AND user_id = $2 AND active = TRUE',
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Delete item error:', err.message);
    return res.status(500).json({ error: 'Failed to delete item.' });
  }
});


// ── PUT /api/items/reorder ──
// Batch update sort orders
router.put('/reorder/batch', async (req, res) => {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'Orders must be an array of { id, sortOrder }.' });
    }

    for (const { id, sortOrder } of orders) {
      await query(
        'UPDATE items SET sort_order = $1 WHERE id = $2 AND user_id = $3',
        [sortOrder, id, req.user.id]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Reorder items error:', err.message);
    return res.status(500).json({ error: 'Failed to reorder items.' });
  }
});


module.exports = router;
