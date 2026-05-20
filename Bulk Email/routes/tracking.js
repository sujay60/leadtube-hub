const express = require('express');
const { getDb } = require('../database/db');

const router = express.Router();

// 1x1 transparent GIF pixel for open tracking
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);

// Open tracking pixel
router.get('/o/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  const db = getDb();

  try {
    const email = db.prepare('SELECT * FROM campaign_emails WHERE tracking_id = ?').get(trackingId);
    if (email && !email.opened_at) {
      db.prepare("UPDATE campaign_emails SET opened_at = CURRENT_TIMESTAMP WHERE tracking_id = ?").run(trackingId);
      db.prepare("UPDATE campaigns SET opened_count = opened_count + 1 WHERE id = ?").run(email.campaign_id);
    }
    db.prepare(`
      INSERT INTO tracking_events (tracking_id, event_type, user_agent, ip_address)
      VALUES (?, 'open', ?, ?)
    `).run(trackingId, req.headers['user-agent'] || '', req.ip);
  } catch (e) { /* silent fail for tracking */ }

  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
  res.send(TRACKING_PIXEL);
});

// Click tracking redirect
router.get('/c/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing URL');

  const db = getDb();
  try {
    const email = db.prepare('SELECT * FROM campaign_emails WHERE tracking_id = ?').get(trackingId);
    if (email && !email.clicked_at) {
      db.prepare("UPDATE campaign_emails SET clicked_at = CURRENT_TIMESTAMP WHERE tracking_id = ?").run(trackingId);
      db.prepare("UPDATE campaigns SET clicked_count = clicked_count + 1 WHERE id = ?").run(email.campaign_id);
    }
    db.prepare(`
      INSERT INTO tracking_events (tracking_id, event_type, url, user_agent, ip_address)
      VALUES (?, 'click', ?, ?, ?)
    `).run(trackingId, url, req.headers['user-agent'] || '', req.ip);
  } catch (e) { /* silent fail */ }

  res.redirect(url);
});

// Get tracking analytics for a campaign
router.get('/analytics/:campaignId', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT te.*, ce.contact_id FROM tracking_events te
    JOIN campaign_emails ce ON te.tracking_id = ce.tracking_id
    WHERE ce.campaign_id = ?
    ORDER BY te.created_at DESC
  `).all(req.params.campaignId);
  res.json(events);
});

module.exports = router;
