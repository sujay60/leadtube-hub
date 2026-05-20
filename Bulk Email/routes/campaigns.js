const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const { sendCampaignEmails, pauseCampaign, resumeCampaign, createFollowUp } = require('../services/emailService');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const campaigns = db.prepare(`
    SELECT c.*, t.name as template_name, cg.name as group_name, a.email as sender_email,
           pc.name as parent_campaign_name
    FROM campaigns c
    LEFT JOIN templates t ON c.template_id = t.id
    LEFT JOIN contact_groups cg ON c.group_id = cg.id
    LEFT JOIN accounts a ON c.account_id = a.id
    LEFT JOIN campaigns pc ON c.follow_up_of = pc.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(campaigns);
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const campaign = db.prepare(`
    SELECT c.*, t.name as template_name, t.subject as template_subject,
           cg.name as group_name, a.email as sender_email
    FROM campaigns c
    LEFT JOIN templates t ON c.template_id = t.id
    LEFT JOIN contact_groups cg ON c.group_id = cg.id
    LEFT JOIN accounts a ON c.account_id = a.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const emails = db.prepare(`
    SELECT ce.*, ct.email, ct.first_name, ct.channel_name
    FROM campaign_emails ce
    JOIN contacts ct ON ce.contact_id = ct.id
    WHERE ce.campaign_id = ?
    ORDER BY ce.sent_at DESC
  `).all(req.params.id);

  // Build full follow-up chain: walk up to root, then walk down to leaf
  let rootId = campaign.id;
  let visited = new Set();
  let walkId = campaign.id;
  while (walkId && !visited.has(walkId)) {
    visited.add(walkId);
    const row = db.prepare('SELECT id, follow_up_of FROM campaigns WHERE id = ?').get(walkId);
    if (row && row.follow_up_of) {
      walkId = row.follow_up_of;
      rootId = walkId;
    } else {
      rootId = walkId;
      break;
    }
  }

  // Walk down from root collecting the chain
  const chain = [];
  let currentId = rootId;
  let step = 0;
  visited.clear();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const c = db.prepare(`
      SELECT c.id, c.name, c.status, c.total_emails, c.sent_count, c.failed_count,
             c.opened_count, c.clicked_count, c.follow_up_of, c.follow_up_condition,
             c.follow_up_days, c.scheduled_send_at, c.is_paused, c.delay_ms,
             t.name as template_name, t.subject as template_subject
      FROM campaigns c
      LEFT JOIN templates t ON c.template_id = t.id
      WHERE c.id = ?
    `).get(currentId);
    if (!c) break;
    c.step = step;
    chain.push(c);
    step++;
    // Find child
    const child = db.prepare('SELECT id FROM campaigns WHERE follow_up_of = ?').get(currentId);
    currentId = child ? child.id : null;
  }

  res.json({ ...campaign, emails, chain });
});

router.get('/:id/status', (req, res) => {
  const db = getDb();
  const campaign = db.prepare(
    'SELECT id, status, total_emails, sent_count, failed_count, opened_count, clicked_count, is_paused, delay_ms FROM campaigns WHERE id = ?'
  ).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

// Create campaign with custom delay, round-robin, and tree sequence
router.post('/', (req, res) => {
  const { name, group_id, account_id, account_ids, delay_ms, tree } = req.body;
  const ids = account_ids && account_ids.length ? account_ids : (account_id ? [account_id] : []);
  
  if (!name || !group_id || !ids.length || !tree || !tree.length) {
    return res.status(400).json({ error: 'All fields and tree structure are required' });
  }

  const db = getDb();
  const rootNode = tree.find(n => n.parentId === null);
  if (!rootNode) return res.status(400).json({ error: 'Root node is missing' });

  // Create template for root
  const rootTpl = db.prepare('INSERT INTO templates (name, subject, body_html, body_text) VALUES (?, ?, ?, ?)').run(
    `Sequence: ${rootNode.subject.substring(0, 40)}`, rootNode.subject, (rootNode.body||'').replace(/\n/g, '<br>'), rootNode.body
  );

  const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE group_id = ?').get(group_id);
  const result = db.prepare(`
    INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, account_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, rootTpl.lastInsertRowid, group_id, ids[0], contactCount.count, delay_ms || 2000, JSON.stringify(ids));

  const rootCampaignId = result.lastInsertRowid;

  const contacts = db.prepare('SELECT id FROM contacts WHERE group_id = ?').all(group_id);
  for (const contact of contacts) {
    db.prepare('INSERT INTO campaign_emails (campaign_id, contact_id, tracking_id) VALUES (?, ?, ?)').run(rootCampaignId, contact.id, uuidv4());
  }

  const dbIds = { [rootNode.id]: rootCampaignId };
  
  // Process children
  let processedCount = 1;
  while (processedCount < tree.length) {
    let madeProgress = false;
    for (const node of tree) {
      if (!dbIds[node.id] && dbIds[node.parentId]) {
        const tpl = db.prepare('INSERT INTO templates (name, subject, body_html, body_text) VALUES (?, ?, ?, ?)').run(
          `Follow-up: ${node.subject.substring(0, 40)}`, node.subject, (node.body||'').replace(/\n/g, '<br>'), node.body
        );
        
        const fuResult = db.prepare(`
          INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, follow_up_of, follow_up_days, follow_up_condition, account_ids, status)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'draft')
        `).run(
          `Follow-up branch: ${name}`, tpl.lastInsertRowid, group_id, ids[0], delay_ms || 2000, dbIds[node.parentId], node.delay_days || 1, node.condition || 'not_opened', JSON.stringify(ids)
        );
        
        dbIds[node.id] = fuResult.lastInsertRowid;
        processedCount++;
        madeProgress = true;
      }
    }
    if (!madeProgress) {
      console.error("Tree has disconnected nodes or invalid parentIds");
      break;
    }
  }

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(rootCampaignId);
  res.status(201).json(campaign);
});

// Send campaign
router.post('/:id/send', async (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'sending') return res.status(400).json({ error: 'Already sending' });

  db.prepare("UPDATE campaigns SET status = 'sending', is_paused = 0, started_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);
  sendCampaignEmails(campaign.id).catch(err => {
    console.error('Campaign send error:', err);
    db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
  });
  res.json({ success: true, message: 'Campaign is now sending' });
});

// Pause campaign
router.post('/:id/pause', (req, res) => {
  pauseCampaign(parseInt(req.params.id));
  res.json({ success: true, message: 'Campaign paused' });
});

// Resume campaign
router.post('/:id/resume', (req, res) => {
  resumeCampaign(parseInt(req.params.id));
  res.json({ success: true, message: 'Campaign resumed' });
});

// Update delay while sending
router.post('/:id/delay', (req, res) => {
  const { delay_ms } = req.body;
  if (!delay_ms || delay_ms < 500) return res.status(400).json({ error: 'Delay must be at least 500ms' });
  const db = getDb();
  db.prepare('UPDATE campaigns SET delay_ms = ? WHERE id = ?').run(delay_ms, req.params.id);
  res.json({ success: true });
});

// Create follow-up campaign
router.post('/:id/follow-up', async (req, res) => {
  const { template_id, condition, delay_days } = req.body;
  if (!template_id) return res.status(400).json({ error: 'Template is required' });

  try {
    const followUp = await createFollowUp(
      parseInt(req.params.id),
      template_id,
      condition || 'not_opened',
      delay_days || 1
    );
    res.status(201).json(followUp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preview email for a specific contact
router.post('/:id/preview', (req, res) => {
  const { contact_id } = req.body;
  const db = getDb();
  const campaign = db.prepare(`
    SELECT c.*, t.subject, t.body_html FROM campaigns c
    JOIN templates t ON c.template_id = t.id WHERE c.id = ?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const { renderTemplate } = require('../services/templateEngine');
  res.json({ subject: renderTemplate(campaign.subject, contact), body: renderTemplate(campaign.body_html, contact) });
});

// Delete campaign
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM campaign_emails WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
