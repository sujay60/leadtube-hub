const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const { sendCampaignEmails, pauseCampaign, resumeCampaign, createFollowUp } = require('../services/emailService');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const campaigns = db.prepare(`
    SELECT c.*, t.name as template_name, cg.name as group_name, a.email as sender_email,
           pc.name as parent_campaign_name
    FROM campaigns c
    LEFT JOIN templates t ON c.template_id = t.id
    LEFT JOIN contact_groups cg ON c.group_id = cg.id
    LEFT JOIN accounts a ON c.account_id = a.id
    LEFT JOIN campaigns pc ON c.follow_up_of = pc.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId);
  res.json(campaigns);
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const campaign = db.prepare(`
    SELECT c.*, t.name as template_name, t.subject as template_subject,
           cg.name as group_name, a.email as sender_email
    FROM campaigns c
    LEFT JOIN templates t ON c.template_id = t.id
    LEFT JOIN contact_groups cg ON c.group_id = cg.id
    LEFT JOIN accounts a ON c.account_id = a.id
    WHERE c.id = ? AND c.user_id = ?
  `).get(req.params.id, userId);
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
  const userId = (req.session && req.session.userId) || null;
  const campaign = db.prepare(
    'SELECT id, status, total_emails, sent_count, failed_count, opened_count, clicked_count, is_paused, delay_ms FROM campaigns WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId);
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
  const userId = (req.session && req.session.userId) || null;
  const rootNode = tree.find(n => n.parentId === null);
  if (!rootNode) return res.status(400).json({ error: 'Root node is missing' });

  // Create template for root
  const rootTpl = db.prepare('INSERT INTO templates (name, subject, body_html, body_text, user_id) VALUES (?, ?, ?, ?, ?)').run(
    `Sequence: ${rootNode.subject.substring(0, 40)}`, rootNode.subject, (rootNode.body||'').replace(/\n/g, '<br>'), rootNode.body, userId
  );

  const contactCount = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE group_id = ? AND user_id = ?').get(group_id, userId);
  const result = db.prepare(`
    INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, account_ids, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, rootTpl.lastInsertRowid, group_id, ids[0], contactCount.count, delay_ms || 2000, JSON.stringify(ids), userId);

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
        const tpl = db.prepare('INSERT INTO templates (name, subject, body_html, body_text, user_id) VALUES (?, ?, ?, ?, ?)').run(
          `Follow-up: ${node.subject.substring(0, 40)}`, node.subject, (node.body||'').replace(/\n/g, '<br>'), node.body, userId
        );
        
        const fuResult = db.prepare(`
          INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, follow_up_of, follow_up_days, follow_up_condition, account_ids, status, user_id)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'draft', ?)
        `).run(
          `Follow-up branch: ${name}`, tpl.lastInsertRowid, group_id, ids[0], delay_ms || 2000, dbIds[node.parentId], node.delay_days || 1, node.condition || 'not_opened', JSON.stringify(ids), userId
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

  // If stuck in 'sending' from a server restart, the startup recovery should have reset it.
  // If it somehow still shows 'sending' and no process is running, reject with guidance.
  if (campaign.status === 'sending') {
    return res.status(400).json({
      error: 'Campaign is already sending. If it appears stuck (server restarted), use the Reset Stuck button to recover it.'
    });
  }

  db.prepare("UPDATE campaigns SET status = 'sending', is_paused = 0, started_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);
  sendCampaignEmails(campaign.id).catch(err => {
    console.error(`Campaign ${campaign.id} send error:`, err.message, err.stack || '');
    db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
  });
  res.json({ success: true, message: 'Campaign is now sending' });
});

// Reset a campaign stuck in 'sending' (caused by server restart) back to 'draft'
router.post('/:id/reset-stuck', (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'sending') {
    return res.status(400).json({ error: `Campaign is not stuck — current status: ${campaign.status}` });
  }
  db.prepare("UPDATE campaigns SET status = 'draft', is_paused = 0 WHERE id = ?").run(campaign.id);
  console.log(`  Manual reset: Campaign ${campaign.id} "${campaign.name}" reset from 'sending' to 'draft'`);
  res.json({ success: true, message: 'Campaign reset to draft. You can now click Send again.' });
});

// Retry failed emails in a campaign
router.post('/:id/retry-failed', (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'sending') return res.status(400).json({ error: 'Campaign is already sending' });

  // Update failed emails back to pending
  const resetResult = db.prepare("UPDATE campaign_emails SET status = 'pending', error_message = NULL WHERE campaign_id = ? AND status = 'failed'").run(campaign.id);
  
  if (resetResult.changes === 0) {
    return res.status(400).json({ error: 'No failed emails found to retry' });
  }

  // Update campaign status and reset failed count
  db.prepare("UPDATE campaigns SET status = 'sending', failed_count = 0, is_paused = 0, started_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(campaign.id);

  // Trigger sending
  sendCampaignEmails(campaign.id).catch(err => {
    console.error(`Campaign ${campaign.id} retry send error:`, err.message, err.stack || '');
    db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
  });

  res.json({ success: true, message: `Retrying ${resetResult.changes} failed emails` });
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

// Diagnose email sending — test connectivity and return detailed errors
router.post('/diagnose', async (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);
  
  if (!accounts.length) {
    return res.json({ 
      success: false, 
      error: 'No email accounts configured. Go to Accounts tab and add one.',
      accounts: [],
      env: {
        hasClientId: !!process.env.GOOGLE_CLIENT_ID,
        hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
        baseUrl: process.env.BASE_URL || '(not set — defaults to https://leadtube.onrender.com)',
        nodeEnv: process.env.NODE_ENV || '(not set)'
      }
    });
  }

  const results = [];
  for (const acc of accounts) {
    const result = { 
      email: acc.email, 
      type: acc.refresh_token === 'app_password' ? 'App Password' : 'OAuth2',
      hasAccessToken: !!acc.access_token,
      hasRefreshToken: !!acc.refresh_token,
      tokenExpiry: acc.token_expiry ? new Date(acc.token_expiry).toISOString() : 'N/A',
      tokenExpired: acc.token_expiry ? acc.token_expiry < Date.now() : 'N/A'
    };
    
    try {
      const nodemailer = require('nodemailer');
      
      if (acc.refresh_token === 'app_password') {
        // Test App Password SMTP connection
        const transporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: { user: acc.email, pass: acc.access_token },
          connectionTimeout: 10000,
          socketTimeout: 10000,
          tls: { rejectUnauthorized: false }
        });
        await transporter.verify();
        result.status = 'OK';
        result.message = 'SMTP connection successful!';
      } else {
        // Test OAuth2 — try Gmail API
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          `${process.env.BASE_URL || 'https://leadtube.onrender.com'}/auth/google/callback`
        );
        oauth2Client.setCredentials({
          access_token: acc.access_token,
          refresh_token: acc.refresh_token,
          expiry_date: acc.token_expiry
        });
        
        // Try to refresh the token
        const { credentials } = await oauth2Client.refreshAccessToken();
        db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
          .run(credentials.access_token, credentials.expiry_date, acc.id);
        
        // Try to list 1 message to verify Gmail API works
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        await gmail.users.getProfile({ userId: 'me' });
        
        result.status = 'OK';
        result.message = 'OAuth2 token refresh + Gmail API access successful!';
        result.newExpiry = new Date(credentials.expiry_date).toISOString();
      }
    } catch (err) {
      result.status = 'FAILED';
      result.message = err.message;
      result.code = err.code || '';
      result.fullError = (err.stack || '').split('\n').slice(0, 5).join('\n');
    }
    results.push(result);
  }

  res.json({
    success: results.every(r => r.status === 'OK'),
    accounts: results,
    env: {
      hasClientId: !!process.env.GOOGLE_CLIENT_ID,
      hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      clientIdPreview: process.env.GOOGLE_CLIENT_ID ? `${process.env.GOOGLE_CLIENT_ID.substring(0, 8)}...${process.env.GOOGLE_CLIENT_ID.substring(process.env.GOOGLE_CLIENT_ID.length - 8)}` : '(none)',
      clientSecretPreview: process.env.GOOGLE_CLIENT_SECRET ? `${process.env.GOOGLE_CLIENT_SECRET.substring(0, 8)}...${process.env.GOOGLE_CLIENT_SECRET.substring(process.env.GOOGLE_CLIENT_SECRET.length - 8)}` : '(none)',
      clientIdLength: process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.length : 0,
      clientSecretLength: process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.length : 0,
      baseUrl: process.env.BASE_URL || '(not set)',
      nodeEnv: process.env.NODE_ENV || '(not set)'
    }
  });
});

// Delete campaign
router.delete('/:id', (req, res) => {
  const db = getDb();
  const userId = (req.session && req.session.userId) || null;
  db.prepare('DELETE FROM campaign_emails WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.json({ success: true });
});

module.exports = router;
