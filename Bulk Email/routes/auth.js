const express = require('express');
const { google } = require('googleapis');
const { getDb } = require('../database/db');

const router = express.Router();

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || 'https://leadtube.onrender.com'}/auth/google/callback`
  );
}

// Check if OAuth2 is configured
function isOAuthConfigured() {
  return process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_CLIENT_ID.length > 5 && process.env.GOOGLE_CLIENT_SECRET.length > 5;
}

// Check if App Password mode is configured
function isAppPasswordConfigured() {
  return process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD &&
    process.env.GMAIL_APP_PASSWORD.length > 3;
}

// Get auth mode info
router.get('/mode', (req, res) => {
  res.json({
    oauth_configured: isOAuthConfigured(),
    app_password_configured: isAppPasswordConfigured(),
    mode: isOAuthConfigured() ? 'oauth' : (isAppPasswordConfigured() ? 'app_password' : 'none')
  });
});

// ===== APP PASSWORD: Quick-add account =====
router.post('/add-account', (req, res) => {
  const { email, app_password } = req.body;

  // Use env values if not provided in body
  const userEmail = email || process.env.GMAIL_USER;
  const userPassword = app_password || process.env.GMAIL_APP_PASSWORD;

  if (!userEmail || !userPassword) {
    return res.status(400).json({ error: 'Email and app password are required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(userEmail);

  if (existing) {
    db.prepare(`UPDATE accounts SET access_token = ?, refresh_token = 'app_password', display_name = ? WHERE email = ?`)
      .run(userPassword, userEmail.split('@')[0], userEmail);
  } else {
    db.prepare(`INSERT INTO accounts (email, display_name, picture_url, access_token, refresh_token, token_expiry)
      VALUES (?, ?, '', ?, 'app_password', 0)`)
      .run(userEmail, userEmail.split('@')[0], userPassword);
  }

  const account = db.prepare('SELECT id, email, display_name, picture_url, created_at FROM accounts WHERE email = ?').get(userEmail);
  res.json(account);
});

// ===== OAUTH2: Initiate Google OAuth2 flow =====
router.get('/google', (req, res) => {
  if (!isOAuthConfigured()) {
    return res.redirect('/#/accounts?error=oauth_not_configured');
  }
  const oauth2Client = getOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// OAuth2 callback
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    if (state === 'hub_login') return res.redirect('/login.html?error=no_code');
    return res.redirect('/#/accounts?error=no_code');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Check if this is a hub login request
    if (state === 'hub_login') {
      const db = getDb();
      let user = db.prepare('SELECT id, username, email FROM hub_users WHERE email = ?').get(profile.email.toLowerCase());
      
      if (!user) {
        let username = profile.email.split('@')[0].toLowerCase();
        const existingUsername = db.prepare('SELECT id FROM hub_users WHERE username = ?').get(username);
        if (existingUsername) {
          username = username + Math.floor(Math.random() * 1000);
        }
        
        const result = db.prepare(
          'INSERT INTO hub_users (username, email, password_hash) VALUES (?, ?, ?)'
        ).run(username, profile.email.toLowerCase(), 'google_oauth');
        
        user = {
          id: result.lastInsertRowid,
          username: username,
          email: profile.email.toLowerCase()
        };
      }
      
      req.session.userId = user.id;
      req.session.username = user.username;
      
      return res.redirect('/');
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(profile.email);

    if (existing) {
      db.prepare(`UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
            token_expiry = ?, display_name = ?, picture_url = ? WHERE email = ?`)
        .run(tokens.access_token, tokens.refresh_token, tokens.expiry_date, profile.name, profile.picture, profile.email);
    } else {
      db.prepare(`INSERT INTO accounts (email, display_name, picture_url, access_token, refresh_token, token_expiry)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(profile.email, profile.name, profile.picture, tokens.access_token, tokens.refresh_token || '', tokens.expiry_date);
    }

    req.session.authenticated = true;
    res.redirect('/#/accounts?success=connected');
  } catch (error) {
    console.error('OAuth callback error:', error);
    if (state === 'hub_login') return res.redirect('/login.html?error=auth_failed');
    res.redirect('/#/accounts?error=auth_failed');
  }
});

// List connected accounts
router.get('/accounts', (req, res) => {
  const db = getDb();
  const accounts = db.prepare('SELECT id, email, display_name, picture_url, created_at FROM accounts').all();
  res.json(accounts);
});

// Delete account
router.delete('/accounts/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
