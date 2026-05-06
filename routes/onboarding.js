const express = require('express');
const router = express.Router();
const { query, queryOne, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

// Default starter items, same as the demo
const STARTER_ITEMS = {
  fillers: [
    { label: 'Work pressure', defaultValue: 12 },
    { label: 'Financial worry', defaultValue: 18 },
    { label: 'Poor sleep', defaultValue: 10 },
    { label: 'Family conflict', defaultValue: 15 },
    { label: 'Health concern', defaultValue: 11 },
    { label: 'Isolation', defaultValue: 8 },
    { label: 'Rumination', defaultValue: 9 },
  ],
  emptiers: [
    { label: 'Exercise', defaultValue: 14 },
    { label: 'Good conversation', defaultValue: 11 },
    { label: 'Time outdoors', defaultValue: 9 },
    { label: 'Structured task', defaultValue: 8 },
    { label: 'Rest', defaultValue: 10 },
    { label: 'Music / creativity', defaultValue: 7 },
    { label: 'Helping someone', defaultValue: 6 },
  ],
};


// ── GET /api/onboarding/starters ──
// Returns the suggested starter items for the onboarding screen
// No auth required so the UI can prefetch
router.get('/starters', (req, res) => {
  return res.json(STARTER_ITEMS);
});


// ── POST /api/onboarding/complete ──
// Accepts the user's chosen items and marks onboarding complete
router.post('/complete', requireAuth, async (req, res) => {
  try {
    // Check if already onboarded
    if (req.user.onboarded) {
      return res.status(400).json({ error: 'Already onboarded.' });
    }

    const { items } = req.body;

    // Validate: must have at least one filler and one emptier
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required.' });
    }

    const fillers = items.filter(i => i.type === 'filler');
    const emptiers = items.filter(i => i.type === 'emptier');

    if (fillers.length === 0) {
      return res.status(400).json({ error: 'At least one load item is required.' });
    }
    if (emptiers.length === 0) {
      return res.status(400).json({ error: 'At least one relief item is required.' });
    }

    // Validate each item
    for (const item of items) {
      if (!item.label || typeof item.label !== 'string' || item.label.trim().length === 0) {
        return res.status(400).json({ error: 'Each item must have a label.' });
      }
      if (item.label.length > 60) {
        return res.status(400).json({ error: 'Item labels must be 60 characters or less.' });
      }
      if (!['filler', 'emptier'].includes(item.type)) {
        return res.status(400).json({ error: 'Each item must be type filler or emptier.' });
      }
      if (typeof item.defaultValue !== 'number' || item.defaultValue < 1 || item.defaultValue > 50) {
        return res.status(400).json({ error: 'Default values must be between 1 and 50.' });
      }
    }

    // Create all items and mark onboarded in a transaction
    await transaction(async (client) => {
      let fillerOrder = 0;
      let emptierOrder = 0;

      for (const item of items) {
        const sortOrder = item.type === 'filler' ? ++fillerOrder : ++emptierOrder;
        await client.query(
          `INSERT INTO items (user_id, label, type, default_value, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.id, item.label.trim(), item.type, item.defaultValue, sortOrder]
        );
      }

      await client.query(
        'UPDATE users SET onboarded_at = NOW(), updated_at = NOW() WHERE id = $1',
        [req.user.id]
      );
    });

    return res.json({ ok: true, itemCount: items.length });
  } catch (err) {
    console.error('Onboarding error:', err.message);
    return res.status(500).json({ error: 'Onboarding failed. Please try again.' });
  }
});


module.exports = router;
