const { google } = require('googleapis');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const { getDb } = require('../database/db');

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'https://leadtube.onrender.com'}/auth/google/callback`
  );
}

function getMessageBody(payload) {
  let body_text = '';
  let body_html = '';

  if (!payload) return { body_text, body_html };

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body_text += Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        body_html += Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (part.parts) {
        const nested = getMessageBody(part);
        body_text += nested.body_text;
        body_html += nested.body_html;
      }
    }
  } else if (payload.body && payload.body.data) {
    if (payload.mimeType === 'text/html') {
      body_html = Buffer.from(payload.body.data, 'base64').toString('utf8');
    } else {
      body_text = Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
  }

  return { body_text, body_html };
}

let scannerInterval = null;

function startInboxScanner() {
  if (scannerInterval) return;
  console.log('  📥 Dual-Mode Inbox scanner started (checking every 2 minutes)');

  scannerInterval = setInterval(async () => {
    try {
      await scanInboxes();
    } catch(e) {
      console.error('Inbox scanner error:', e.message);
    }
  }, 2 * 60 * 1000); // Every 2 minutes
}

async function scanInboxes() {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM accounts').all();

  for (const account of accounts) {
    try {
      if (account.refresh_token === 'app_password') {
        await scanImapInbox(account, db);
      } else {
        await scanOAuthInbox(account, db);
      }
    } catch (err) {
      console.error(`Error scanning inbox for ${account.email}:`, err.message);
    }
  }
}

async function processReply(db, account, messageId, refIds, subject, body_text, body_html) {
  if (refIds.length === 0) return false;

  const existing = db.prepare('SELECT id FROM replies WHERE message_id = ?').get(messageId);
  if (existing) return false; // Already processed

  for (const refId of refIds) {
    const cleanRefId = refId.replace(/^<|>$/g, '');
    const sentRecord = db.prepare(`
      SELECT * FROM campaign_emails 
      WHERE message_id = ? OR message_id = ?
    `).get(refId, `<${cleanRefId}>`);

    if (sentRecord) {
      const threadId = sentRecord.campaign_id + '-' + sentRecord.contact_id;

      db.prepare(`
        INSERT INTO replies (account_id, contact_id, campaign_id, message_id, thread_id, subject, body_text, body_html, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(account.id, sentRecord.contact_id, sentRecord.campaign_id, messageId, threadId, subject, body_text, body_html);

      db.prepare('UPDATE campaign_emails SET replied_at = CURRENT_TIMESTAMP WHERE id = ?').run(sentRecord.id);
      
      console.log(`  🎉 Reply received for contact ${sentRecord.contact_id}! Sequence will be paused.`);
      return true;
    }
  }
  return false;
}

// ===== OAUTH SCANNER =====
async function scanOAuthInbox(account, db) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry
  });

  if (account.token_expiry && account.token_expiry < Date.now()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
      .run(credentials.access_token, credentials.expiry_date, account.id);
    oauth2Client.setCredentials(credentials);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const res = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:2d' });
  const messages = res.data.messages || [];
  
  for (const msg of messages.slice(0, 50)) { // limit to avoid rate limits
    const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
    const headers = fullMsg.data.payload.headers;
    
    const messageId = (headers.find(h => h.name.toLowerCase() === 'message-id') || {}).value;
    if (!messageId) continue;

    const inReplyTo = (headers.find(h => h.name.toLowerCase() === 'in-reply-to') || {}).value;
    const references = (headers.find(h => h.name.toLowerCase() === 'references') || {}).value;
    
    let refIds = [];
    if (inReplyTo) refIds.push(inReplyTo.trim());
    if (references) refIds = refIds.concat(references.split(/\s+/).filter(Boolean));

    const subject = (headers.find(h => h.name.toLowerCase() === 'subject') || {}).value || 'Re:';
    const { body_text, body_html } = getMessageBody(fullMsg.data.payload);

    await processReply(db, account, messageId, refIds, subject, body_text, body_html);
  }
}

// ===== IMAP SCANNER =====
async function scanImapInbox(account, db) {
  const config = {
    imap: {
      user: account.email,
      password: account.access_token, // access_token stores app_password
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000
    }
  };

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    const delay = 24 * 3600 * 1000; // 1 day
    const since = new Date(Date.now() - delay);
    
    const searchCriteria = [['SINCE', since]];
    const fetchOptions = { bodies: [''], struct: true, markSeen: false };

    const messages = await connection.search(searchCriteria, fetchOptions);

    for (const msg of messages) {
      const rawEmail = msg.parts.find(p => p.which === '').body;
      const parsed = await simpleParser(rawEmail);
      
      const messageId = parsed.messageId;
      if (!messageId) continue;

      let refIds = [];
      if (parsed.inReplyTo) refIds = refIds.concat(Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo : [parsed.inReplyTo]);
      if (parsed.references) refIds = refIds.concat(Array.isArray(parsed.references) ? parsed.references : [parsed.references]);

      await processReply(db, account, messageId, refIds, parsed.subject || 'Re:', parsed.text || body_text, parsed.html || body_html);
    }
  } finally {
    if (connection) connection.end();
  }
}

module.exports = { startInboxScanner, scanInboxes };
