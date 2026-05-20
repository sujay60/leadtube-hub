const express = require('express');
const { getDb } = require('../database/db');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const router = express.Router();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`
  );
}

// Get all replies grouped by thread/contact
router.get('/', (req, res) => {
  const db = getDb();
  const replies = db.prepare(`
    SELECT r.*, c.first_name, c.last_name, c.email as contact_email, a.email as account_email, camp.name as campaign_name,
           (SELECT ce.is_paused FROM campaign_emails ce WHERE ce.campaign_id = r.campaign_id AND ce.contact_id = r.contact_id LIMIT 1) as is_paused
    FROM replies r
    JOIN contacts c ON r.contact_id = c.id
    JOIN accounts a ON r.account_id = a.id
    JOIN campaigns camp ON r.campaign_id = camp.id
    ORDER BY r.received_at DESC
  `).all();
  res.json(replies);
});

// Mark reply as read
router.post('/:id/read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE replies SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Send manual reply
router.post('/reply', async (req, res) => {
  const { reply_id, text_body } = req.body;
  if (!reply_id || !text_body) return res.status(400).json({ error: 'Missing reply_id or text_body' });

  const db = getDb();
  const reply = db.prepare(`
    SELECT r.*, a.email as sender_email, a.access_token, a.refresh_token, a.token_expiry, c.email as to_email
    FROM replies r
    JOIN accounts a ON r.account_id = a.id
    JOIN contacts c ON r.contact_id = c.id
    WHERE r.id = ?
  `).get(reply_id);

  if (!reply) return res.status(404).json({ error: 'Reply not found' });

  try {
    let transporter;
    if (reply.refresh_token === 'app_password') {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: reply.sender_email, pass: reply.access_token }
      });
    } else {
      const oauth2Client = getOAuth2Client();
      oauth2Client.setCredentials({
        access_token: reply.access_token,
        refresh_token: reply.refresh_token,
        expiry_date: reply.token_expiry
      });

      if (reply.token_expiry && reply.token_expiry < Date.now()) {
        const { credentials } = await oauth2Client.refreshAccessToken();
        db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
          .run(credentials.access_token, credentials.expiry_date, reply.account_id);
        oauth2Client.setCredentials(credentials);
      }

      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: reply.sender_email,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          refreshToken: reply.refresh_token,
          accessToken: oauth2Client.credentials.access_token
        }
      });
    }

    const mailOptions = {
      from: reply.sender_email,
      to: reply.to_email,
      subject: reply.subject.startsWith('Re:') ? reply.subject : `Re: ${reply.subject}`,
      text: text_body,
      inReplyTo: reply.message_id,
      references: reply.message_id
    };

    const info = await transporter.sendMail(mailOptions);
    
    // Log our sent manual reply to the replies table to keep the thread history visible (optional but nice)
    db.prepare(`
      INSERT INTO replies (account_id, contact_id, campaign_id, message_id, thread_id, subject, body_text, received_at, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
    `).run(reply.account_id, reply.contact_id, reply.campaign_id, info.messageId, reply.thread_id, mailOptions.subject, `[You replied]:\n${text_body}`);

    res.json({ success: true, messageId: info.messageId });
  } catch(e) {
    console.error('Manual reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pause follow-ups for a contact in a campaign
router.post('/pause-contact', (req, res) => {
  const { contact_id, campaign_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'Missing contact_id' });
  
  const db = getDb();
  if (campaign_id) {
    db.prepare('UPDATE campaign_emails SET is_paused = 1 WHERE contact_id = ? AND campaign_id = ?').run(contact_id, campaign_id);
  } else {
    db.prepare('UPDATE campaign_emails SET is_paused = 1 WHERE contact_id = ?').run(contact_id);
  }
  
  res.json({ success: true });
});

// Resume follow-ups for a contact in a campaign
router.post('/resume-contact', (req, res) => {
  const { contact_id, campaign_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'Missing contact_id' });
  
  const db = getDb();
  if (campaign_id) {
    db.prepare('UPDATE campaign_emails SET is_paused = 0 WHERE contact_id = ? AND campaign_id = ?').run(contact_id, campaign_id);
  } else {
    db.prepare('UPDATE campaign_emails SET is_paused = 0 WHERE contact_id = ?').run(contact_id);
  }
  
  res.json({ success: true });
});

module.exports = router;
