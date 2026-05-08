const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hasFullAccess } = require('../middleware/tier');

const DEFAULT_SETTINGS = { showChart: true, showLog: true, showItemLabels: true };

function validateSettings(s) {
  if (!s || typeof s !== 'object') return DEFAULT_SETTINGS;
  return {
    showChart: s.showChart !== false,
    showLog: s.showLog !== false,
    showItemLabels: s.showItemLabels !== false,
  };
}


// ── POST /api/share ──
router.post('/', requireAuth, async (req, res) => {
  try {
    if (!hasFullAccess(req.user)) {
      return res.status(403).json({ error: 'Share links require a full account.', upgrade: true });
    }

    const { label, settings } = req.body;
    const tokenLabel = (label && label.trim()) || 'Shared view';

    if (tokenLabel.length > 60) {
      return res.status(400).json({ error: 'Label must be 60 characters or less.' });
    }

    const countResult = await queryOne(
      'SELECT COUNT(*) AS count FROM share_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [req.user.id]
    );
    if (parseInt(countResult.count) >= 10) {
      return res.status(400).json({ error: 'Maximum of 10 active share links.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const shareSettings = validateSettings(settings);

    const result = await queryOne(
      `INSERT INTO share_tokens (user_id, token, label, settings)
       VALUES ($1, $2, $3, $4)
       RETURNING id, token, label, settings, created_at`,
      [req.user.id, token, tokenLabel, JSON.stringify(shareSettings)]
    );

    return res.status(201).json({
      share: {
        id: result.id,
        token: result.token,
        label: result.label,
        settings: result.settings,
        url: `${req.protocol}://${req.get('host')}/#/shared/${result.token}`,
        createdAt: result.created_at,
        active: true,
      },
    });
  } catch (err) {
    console.error('Create share error:', err.message);
    return res.status(500).json({ error: 'Failed to create share link.' });
  }
});


// ── GET /api/share ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, token, label, settings, created_at, revoked_at
       FROM share_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.json({
      shares: result.rows.map(r => ({
        id: r.id,
        token: r.token,
        label: r.label,
        settings: r.settings || DEFAULT_SETTINGS,
        url: `${req.protocol}://${req.get('host')}/#/shared/${r.token}`,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        active: !r.revoked_at,
      })),
    });
  } catch (err) {
    console.error('List shares error:', err.message);
    return res.status(500).json({ error: 'Failed to load share links.' });
  }
});


// ── PUT /api/share/:id ──
// Update share settings
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { label, settings } = req.body;

    const updates = [];
    const values = [];
    let idx = 1;

    if (label !== undefined) {
      if (label.length > 60) return res.status(400).json({ error: 'Label must be 60 characters or less.' });
      updates.push(`label = $${idx++}`);
      values.push(label.trim());
    }
    if (settings !== undefined) {
      updates.push(`settings = $${idx++}`);
      values.push(JSON.stringify(validateSettings(settings)));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.id, req.user.id);
    const result = await query(
      `UPDATE share_tokens SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} AND revoked_at IS NULL`,
      values
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Share link not found.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Update share error:', err.message);
    return res.status(500).json({ error: 'Failed to update share link.' });
  }
});


// ── DELETE /api/share/:id ──
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE share_tokens SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Share link not found or already revoked.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Revoke share error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke share link.' });
  }
});


// ── GET /api/shared/view/:token ──
// Public endpoint (no auth)
router.get('/view/:token', async (req, res) => {
  try {
    const share = await queryOne(
      `SELECT st.user_id, st.label, st.settings, u.display_name, u.timezone
       FROM share_tokens st
       JOIN users u ON u.id = st.user_id
       WHERE st.token = $1 AND st.revoked_at IS NULL`,
      [req.params.token]
    );

    if (!share) {
      return res.status(404).json({ error: 'Share link not found or has been revoked.' });
    }

    const settings = share.settings || DEFAULT_SETTINGS;

    const { getCurrentLevel } = require('./entries');
    const level = await getCurrentLevel(share.user_id, share.timezone);
    const headroom = 100 - level;

    let word = 'calm';
    if (level > 85) word = 'critical';
    else if (level > 70) word = 'high';
    else if (level > 55) word = 'elevated';
    else if (level > 40) word = 'building';
    else if (level > 20) word = 'settled';

    // Only fetch entries if chart or log is enabled
    let entries = [];
    if (settings.showChart || settings.showLog) {
      const result = await query(
        `SELECT e.id, i.label, i.type, e.value, e.level_after, e.logged_at
         FROM entries e
         JOIN items i ON i.id = e.item_id
         WHERE e.user_id = $1
           AND e.logged_at >= NOW() - INTERVAL '7 days'
         ORDER BY e.logged_at DESC
         LIMIT 200`,
        [share.user_id]
      );

      entries = result.rows.map(r => ({
        id: r.id,
        label: settings.showItemLabels ? r.label : (r.type === 'filler' ? 'Load' : 'Relief'),
        type: r.type,
        value: r.value,
        levelAfter: r.level_after,
        loggedAt: r.logged_at,
      }));
    }

    return res.json({
      displayName: share.display_name || 'Anonymous',
      shareLabel: share.label,
      settings,
      level,
      headroom,
      word,
      entries,
    });
  } catch (err) {
    console.error('View share error:', err.message);
    return res.status(500).json({ error: 'Failed to load shared view.' });
  }
});


module.exports = router;
