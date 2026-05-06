const express = require('express');
const router = express.Router();
const { query, queryOne, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);


// ── GET /api/me/export ──
// GDPR data export - returns all user data as JSON
router.get('/export', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await queryOne(
      'SELECT id, email, display_name, tier, early_adopter, timezone, created_at, onboarded_at FROM users WHERE id = $1',
      [userId]
    );

    const items = await query(
      'SELECT id, label, type, default_value, sort_order, active, created_at FROM items WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );

    const entries = await query(
      `SELECT e.id, i.label, i.type, e.value, e.level_after, e.logged_at
       FROM entries e JOIN items i ON i.id = e.item_id
       WHERE e.user_id = $1 ORDER BY e.logged_at`,
      [userId]
    );

    const shares = await query(
      'SELECT id, label, created_at, revoked_at FROM share_tokens WHERE user_id = $1',
      [userId]
    );

    const consents = await query(
      'SELECT consent_type, consent_text, created_at FROM consent_log WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );

    // Log the export in consent log
    await query(
      `INSERT INTO consent_log (user_id, consent_type, consent_text, ip_address)
       VALUES ($1, 'data_export', 'User requested full data export', $2)`,
      [userId, req.ip]
    );

    const exportData = {
      exportedAt: new Date().toISOString(),
      user,
      items: items.rows,
      entries: entries.rows,
      shareTokens: shares.rows,
      consentLog: consents.rows,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="headroom-export-${userId}.json"`);
    return res.json(exportData);
  } catch (err) {
    console.error('Data export error:', err.message);
    return res.status(500).json({ error: 'Failed to export data.' });
  }
});


// ── DELETE /api/me ──
// GDPR account deletion - permanently removes all user data
router.delete('/', async (req, res) => {
  try {
    const { confirmation } = req.body;

    if (confirmation !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({
        error: 'Please send confirmation: "DELETE MY ACCOUNT" to proceed.',
      });
    }

    const userId = req.user.id;

    // Prevent admin self-deletion via this route
    if (req.user.isAdmin) {
      return res.status(400).json({
        error: 'Admin accounts cannot be deleted via self-service. Use the admin panel.',
      });
    }

    await transaction(async (client) => {
      // Log the deletion consent before deleting
      await client.query(
        `INSERT INTO consent_log (user_id, consent_type, consent_text, ip_address)
         VALUES ($1, 'account_deletion', 'User confirmed permanent account deletion', $2)`,
        [userId, req.ip]
      );

      // Nullify donation references (keep financial records)
      await client.query('UPDATE donations SET user_id = NULL WHERE user_id = $1', [userId]);

      // Delete user (cascades to items, entries, sessions, shares, consents, password_resets)
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    });

    res.clearCookie('session', { path: '/' });
    return res.json({ ok: true, message: 'Account and all data permanently deleted.' });
  } catch (err) {
    console.error('Account deletion error:', err.message);
    return res.status(500).json({ error: 'Account deletion failed. Please contact support.' });
  }
});


module.exports = router;
