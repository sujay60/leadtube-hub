const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { getDb } = require('../database/db');
const { renderTemplate, injectTracking } = require('./templateEngine');

const activeCampaigns = new Map();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'https://leadtube.onrender.com'}/auth/google/callback`
  );
}

async function createTransport(account) {
  if (account.refresh_token === 'app_password') {
    // App Passwords can only use SMTP — will fail on hosts that block port 465/587
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: account.email, pass: account.access_token },
      connectionTimeout: 15000,
      socketTimeout: 15000,
      tls: { rejectUnauthorized: false }
    });
  }

  // OAuth2 accounts: Use Gmail REST API (HTTPS, port 443) to bypass SMTP port blocks
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry
  });

  let credentials;
  try {
    const refreshResult = await oauth2Client.refreshAccessToken();
    credentials = refreshResult.credentials;
  } catch (refreshErr) {
    console.error(`[emailService] Failed to refresh OAuth token for ${account.email}:`, refreshErr.message);
    throw new Error(`Token refresh failed: ${refreshErr.message}. Please reconnect this account in the Accounts tab.`);
  }

  const db = getDb();
  db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
    .run(credentials.access_token, credentials.expiry_date, account.id);

  // Update the client with fresh credentials
  oauth2Client.setCredentials(credentials);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const MailComposer = require('nodemailer/lib/mail-composer');

  // Return a transporter-like object that uses Gmail REST API
  return {
    sendMail: async (mailOptions) => {
      const composer = new MailComposer(mailOptions);
      const message = await composer.compile().build();

      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });

      // Extract the Message-ID header from the sent message for threading
      let messageId = null;
      try {
        const sent = await gmail.users.messages.get({ userId: 'me', id: res.data.id, format: 'metadata', metadataHeaders: ['Message-Id'] });
        const header = sent.data.payload.headers.find(h => h.name.toLowerCase() === 'message-id');
        if (header) messageId = header.value;
      } catch (e) { /* ignore — threading still works without it */ }

      return {
        messageId: messageId || res.data.id,
        response: `Gmail API: ${res.data.id}`
      };
    }
  };
}

function pauseCampaign(campaignId) {
  const state = activeCampaigns.get(campaignId);
  if (state) state.paused = true;
  const db = getDb();
  db.prepare("UPDATE campaigns SET is_paused = 1, status = 'paused' WHERE id = ?").run(campaignId);
}

function resumeCampaign(campaignId) {
  const state = activeCampaigns.get(campaignId);
  if (state) {
    state.paused = false;
    state.resolve && state.resolve();
  }
  const db = getDb();
  db.prepare("UPDATE campaigns SET is_paused = 0, status = 'sending' WHERE id = ?").run(campaignId);
  if (!state) {
    sendCampaignEmails(campaignId).catch(err => {
      console.error(`Campaign ${campaignId} resume send error:`, err.message);
      db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaignId);
    });
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function waitWhilePaused(campaignId) {
  return new Promise(resolve => {
    const state = activeCampaigns.get(campaignId);
    if (!state || !state.paused) return resolve();
    state.resolve = resolve;
    const check = setInterval(() => {
      const s = activeCampaigns.get(campaignId);
      if (!s || !s.paused) { clearInterval(check); resolve(); }
    }, 500);
  });
}

function triggerNextStep(campaignId, db) {
  const children = db.prepare("SELECT * FROM campaigns WHERE follow_up_of = ? AND status = 'draft'").all(campaignId);
  if (!children || !children.length) return;

  const { v4: uuidv4 } = require('uuid');
  
  for (const child of children) {
    let contactFilter;
    if (child.follow_up_condition === 'not_opened') contactFilter = "ce.opened_at IS NULL AND ce.status = 'sent'";
    else if (child.follow_up_condition === 'not_clicked') contactFilter = "ce.clicked_at IS NULL AND ce.status = 'sent'";
    else if (child.follow_up_condition === 'opened_not_clicked') contactFilter = "ce.opened_at IS NOT NULL AND ce.clicked_at IS NULL AND ce.status = 'sent'";
    else contactFilter = "ce.status = 'sent'";

    contactFilter += " AND ce.replied_at IS NULL AND (ce.is_paused = 0 OR ce.is_paused IS NULL)";

    const contacts = db.prepare(`SELECT DISTINCT ce.contact_id FROM campaign_emails ce WHERE ce.campaign_id = ? AND ${contactFilter}`).all(campaignId);
    
    for (const c of contacts) {
      db.prepare('INSERT INTO campaign_emails (campaign_id, contact_id, tracking_id) VALUES (?, ?, ?)').run(child.id, c.contact_id, uuidv4());
    }

    if (contacts.length > 0) {
      const scheduledAt = new Date();
      scheduledAt.setDate(scheduledAt.getDate() + child.follow_up_days);
      const scheduledStr = scheduledAt.toISOString().slice(0, 19).replace('T', ' ');
      db.prepare("UPDATE campaigns SET status = 'scheduled', total_emails = ?, scheduled_send_at = ? WHERE id = ?").run(contacts.length, scheduledStr, child.id);
      console.log(`  ⏰ Triggered next step branch: Campaign ${child.id} scheduled for ${scheduledStr}`);
    } else {
      console.log(`  ⏭ Next step branch (Campaign ${child.id}) has 0 qualifying contacts. Skipping and completing.`);
      db.prepare("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP, total_emails = 0 WHERE id = ?").run(child.id);
      triggerNextStep(child.id, db);
    }
  }
}

// Find the original email's Message-ID for threading follow-ups in the same conversation
function getOriginalMessageId(db, campaign, contactId) {
  if (!campaign.follow_up_of) return null;

  // Walk up the follow-up chain to find the root campaign
  let parentId = campaign.follow_up_of;
  let visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = db.prepare('SELECT follow_up_of FROM campaigns WHERE id = ?').get(parentId);
    if (parent && parent.follow_up_of) {
      parentId = parent.follow_up_of;
    } else {
      break;
    }
  }

  // Find the original email sent to this contact in the root campaign
  const originalEmail = db.prepare(
    "SELECT message_id FROM campaign_emails WHERE campaign_id = ? AND contact_id = ? AND message_id IS NOT NULL"
  ).get(parentId, contactId);

  return originalEmail ? originalEmail.message_id : null;
}

// Find the original email's account_id to enforce same-account follow-ups
function getOriginalAccountId(db, campaign, contactId) {
  if (!campaign.follow_up_of) return null;

  // Walk up the follow-up chain to find the root campaign
  let parentId = campaign.follow_up_of;
  let visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = db.prepare('SELECT follow_up_of FROM campaigns WHERE id = ?').get(parentId);
    if (parent && parent.follow_up_of) {
      parentId = parent.follow_up_of;
    } else {
      break;
    }
  }

  // Find the original email sent to this contact in the root campaign
  const originalEmail = db.prepare(
    "SELECT account_id FROM campaign_emails WHERE campaign_id = ? AND contact_id = ? AND account_id IS NOT NULL"
  ).get(parentId, contactId);

  return originalEmail ? originalEmail.account_id : null;
}

async function sendCampaignEmails(campaignId) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(campaign.template_id);

  // Get all accounts for round-robin
  let accountIds = [];
  try { accountIds = JSON.parse(campaign.account_ids || '[]'); } catch(e) {}
  if (!accountIds.length) accountIds = [campaign.account_id];

  const accounts = [];
  const transporters = [];
  for (const aid of accountIds) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(aid);
    if (acc) {
      try {
        const transport = await createTransport(acc);
        transporters.push(transport);
        accounts.push(acc);
      } catch(err) {
        console.error(`Failed to create transport for ${acc.email}:`, err.message);
      }
    }
  }

  if (!transporters.length) {
    db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaignId);
    throw new Error('No valid email accounts available');
  }

  const isFollowUp = !!campaign.follow_up_of;
  console.log(`  📧 Campaign ${campaignId}${isFollowUp ? ' (follow-up, same thread)' : ''}: Round-robin across ${accounts.map(a => a.email).join(', ')}`);

  let query = `
    SELECT ce.*, c.email, c.first_name, c.last_name, c.channel_name, c.channel_url,
           c.subscriber_count, c.niche, c.country, c.language, c.custom_fields
    FROM campaign_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE ce.campaign_id = ? AND ce.status = 'pending' AND ce.replied_at IS NULL AND (ce.is_paused = 0 OR ce.is_paused IS NULL) AND ce.is_skipped = 0
  `;
  if (campaign.daily_limit && campaign.daily_limit > 0) {
    query += ` LIMIT ${campaign.daily_limit}`;
  }
  
  const emailRecords = db.prepare(query).all(campaignId);

  const delay = campaign.delay_ms || 2000;
  let baseUrl = process.env.BASE_URL || 'https://leadtube.onrender.com';
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  activeCampaigns.set(campaignId, { paused: false, resolve: null });

  for (let i = 0; i < emailRecords.length; i++) {
    const record = emailRecords[i];

    await waitWhilePaused(campaignId);

    const current = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
    if (!current || current.status === 'cancelled') break;

    // Determine which account to use
    let account = null;
    let transporter = null;

    if (isFollowUp) {
      const origAccountId = getOriginalAccountId(db, campaign, record.contact_id);
      if (origAccountId) {
        // Find the matching account and transporter
        const idx = accounts.findIndex(a => a.id === origAccountId);
        if (idx !== -1) {
          account = accounts[idx];
          transporter = transporters[idx];
        }
      }
    }

    if (!account) {
      if (isFollowUp) {
        // Skip this contact because original account is disconnected or removed
        console.error(`  ⏭ Skipped follow-up for ${record.email}: Original account disconnected or not available`);
        db.prepare("UPDATE campaign_emails SET status = 'failed', error_message = ? WHERE id = ?").run('Original account disconnected or removed', record.id);
        db.prepare("UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?").run(campaignId);
        continue;
      } else {
        // Round-robin account selection for normal campaigns
        const accIndex = i % accounts.length;
        account = accounts[accIndex];
        transporter = transporters[accIndex];
      }
    }

    try {
      const contact = {
        email: record.email, first_name: record.first_name, last_name: record.last_name,
        channel_name: record.channel_name, channel_url: record.channel_url,
        subscriber_count: record.subscriber_count, niche: record.niche,
        country: record.country, language: record.language, custom_fields: record.custom_fields
      };

      let subject = renderTemplate(template.subject, contact);
      let body = renderTemplate(template.body_html, contact);
      body = injectTracking(body, record.tracking_id, baseUrl);

      // Build mail options
      const mailOptions = {
        from: `${account.display_name || account.email} <${account.email}>`,
        to: record.email,
        subject,
        html: body,
        text: renderTemplate(template.body_text || '', contact)
      };

      // For follow-ups: thread into the same Gmail conversation
      if (isFollowUp) {
        const originalMsgId = getOriginalMessageId(db, campaign, record.contact_id);
        if (originalMsgId) {
          // Add "Re: " prefix if not already there for threading
          if (!subject.toLowerCase().startsWith('re:')) {
            // Get original campaign's template subject for threading
            const parentCampaign = db.prepare('SELECT template_id FROM campaigns WHERE id = ?').get(campaign.follow_up_of);
            if (parentCampaign) {
              const parentTemplate = db.prepare('SELECT subject FROM templates WHERE id = ?').get(parentCampaign.template_id);
              if (parentTemplate) {
                const origSubject = renderTemplate(parentTemplate.subject, contact);
                mailOptions.subject = `Re: ${origSubject}`;
              }
            }
          }
          mailOptions.inReplyTo = originalMsgId;
          mailOptions.references = originalMsgId;
        }
      }

      const info = await transporter.sendMail(mailOptions);

      // Store the Message-ID for future follow-up threading
      const messageId = info.messageId || null;
      db.prepare("UPDATE campaign_emails SET status = 'sent', sent_at = CURRENT_TIMESTAMP, message_id = ?, account_id = ? WHERE id = ?").run(messageId, account.id, record.id);
      db.prepare("UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?").run(campaignId);
    } catch (error) {
      console.error(`Failed to send to ${record.email} via ${account.email}:`, error.message);
      db.prepare("UPDATE campaign_emails SET status = 'failed', error_message = ? WHERE id = ?").run(error.message, record.id);
      db.prepare("UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?").run(campaignId);
    }

    await sleep(delay);
  }

  activeCampaigns.delete(campaignId);

  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM campaign_emails WHERE campaign_id = ? AND status = 'pending' AND is_skipped = 0 AND (is_paused = 0 OR is_paused IS NULL) AND replied_at IS NULL").get(campaignId).count;

  if (pendingCount > 0) {
    console.log(`  ⏸ Campaign ${campaignId} paused because it hit the daily limit. Remaining: ${pendingCount}`);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
  } else {
    db.prepare("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);
    triggerNextStep(campaignId, db);
  }
}

// Create follow-up campaign with auto-scheduling
async function createFollowUp(parentCampaignId, templateId, condition, delayDays) {
  const db = getDb();
  const parent = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(parentCampaignId);
  if (!parent) throw new Error('Parent campaign not found');

  const { v4: uuidv4 } = require('uuid');

  // Walk up the chain to find the root campaign and count steps
  let rootId = parentCampaignId;
  let stepCount = 0;
  let visited = new Set();
  let walkId = parentCampaignId;
  while (walkId && !visited.has(walkId)) {
    visited.add(walkId);
    stepCount++;
    const row = db.prepare('SELECT follow_up_of FROM campaigns WHERE id = ?').get(walkId);
    if (row && row.follow_up_of) {
      walkId = row.follow_up_of;
      rootId = walkId;
    } else {
      rootId = walkId;
      break;
    }
  }

  const rootCampaign = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(rootId);
  const rootName = rootCampaign ? rootCampaign.name : parent.name;

  if (parent.status === 'completed') {
    let contactFilter;
    if (condition === 'not_opened') contactFilter = "ce.opened_at IS NULL AND ce.status = 'sent'";
    else if (condition === 'not_clicked') contactFilter = "ce.clicked_at IS NULL AND ce.status = 'sent'";
    else if (condition === 'opened_not_clicked') contactFilter = "ce.opened_at IS NOT NULL AND ce.clicked_at IS NULL AND ce.status = 'sent'";
    else contactFilter = "ce.status = 'sent'";

    contactFilter += " AND ce.replied_at IS NULL AND (ce.is_paused = 0 OR ce.is_paused IS NULL)";

    const contacts = db.prepare(`
      SELECT DISTINCT ce.contact_id FROM campaign_emails ce
      WHERE ce.campaign_id = ? AND ${contactFilter}
    `).all(parentCampaignId);

    if (!contacts.length) throw new Error('No contacts match the follow-up condition from the completed parent campaign');

    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + (delayDays || 1));
    const scheduledStr = scheduledAt.toISOString().slice(0, 19).replace('T', ' ');

    const result = db.prepare(`
      INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, follow_up_of, follow_up_days, follow_up_condition, account_ids, status, scheduled_send_at, user_id, daily_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
    `).run(
      `Follow-up #${stepCount}: ${rootName}`,
      templateId, parent.group_id, parent.account_id, contacts.length,
      parent.delay_ms || 2000, parentCampaignId, delayDays || 1, condition,
      parent.account_ids || '[]', scheduledStr, parent.user_id, parent.daily_limit || 0
    );

    for (const c of contacts) {
      db.prepare('INSERT INTO campaign_emails (campaign_id, contact_id, tracking_id) VALUES (?, ?, ?)')
        .run(result.lastInsertRowid, c.contact_id, uuidv4());
    }

    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);
  } else {
    const result = db.prepare(`
      INSERT INTO campaigns (name, template_id, group_id, account_id, total_emails, delay_ms, follow_up_of, follow_up_days, follow_up_condition, account_ids, status, user_id, daily_limit)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      `Follow-up #${stepCount}: ${rootName}`,
      templateId, parent.group_id, parent.account_id,
      parent.delay_ms || 2000, parentCampaignId, delayDays || 1, condition,
      parent.account_ids || '[]', parent.user_id, parent.daily_limit || 0
    );
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);
  }
}

// ===== SCHEDULER: auto-send follow-ups when their time comes =====
let schedulerInterval = null;

function startScheduler() {
  if (schedulerInterval) return;
  console.log('  ⏰ Follow-up scheduler started (checking every 60s)');

  schedulerInterval = setInterval(async () => {
    try {
      const db = getDb();
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      // Find campaigns that are scheduled and their time has come
      const dueCampaigns = db.prepare(`
        SELECT * FROM campaigns
        WHERE status = 'scheduled' AND scheduled_send_at <= ?
      `).all(now);

      for (const campaign of dueCampaigns) {
        console.log(`  🚀 Auto-sending scheduled follow-up: "${campaign.name}" (Campaign #${campaign.id})`);
        db.prepare("UPDATE campaigns SET status = 'sending', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);

        sendCampaignEmails(campaign.id).catch(err => {
          console.error(`Scheduled campaign ${campaign.id} failed:`, err.message);
          db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
        });
      }
    } catch(e) {
      console.error('Scheduler error:', e.message);
    }
  }, 60000); // Check every 60 seconds
}

// Also check on startup for any overdue follow-ups
async function checkOverdueFollowUps() {
  try {
    const db = getDb();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const overdue = db.prepare(`
      SELECT * FROM campaigns
      WHERE status = 'scheduled' AND scheduled_send_at <= ?
    `).all(now);

    if (overdue.length) {
      console.log(`  ⚠️  Found ${overdue.length} overdue follow-up(s) — sending now...`);
      for (const campaign of overdue) {
        console.log(`  🚀 Sending overdue follow-up: "${campaign.name}"`);
        db.prepare("UPDATE campaigns SET status = 'sending', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);
        sendCampaignEmails(campaign.id).catch(err => {
          console.error(`Overdue campaign ${campaign.id} failed:`, err.message);
          db.prepare("UPDATE campaigns SET status = 'failed' WHERE id = ?").run(campaign.id);
        });
      }
    }
  } catch(e) {
    console.error('Overdue check error:', e.message);
  }
}

module.exports = { sendCampaignEmails, pauseCampaign, resumeCampaign, createFollowUp, startScheduler, checkOverdueFollowUps };
