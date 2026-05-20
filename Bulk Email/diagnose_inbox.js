const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const { initDatabase, getDb } = require('./database/db');

async function diagnose() {
  await initDatabase();
  const db = getDb();
  
  console.log('--- SENT MESSAGES IN DB ---');
  const sent = db.prepare('SELECT id, contact_id, message_id FROM campaign_emails WHERE status="sent" ORDER BY id DESC LIMIT 20').all();
  sent.forEach(s => console.log(`ID: ${s.id}, Contact: ${s.contact_id}, MsgId: ${s.message_id}`));
  
  const accounts = db.prepare('SELECT * FROM accounts WHERE refresh_token="app_password"').all();

  for (const account of accounts) {
    console.log(`\n--- SCANNING INBOX: ${account.email} ---`);
    const config = {
      imap: {
        user: account.email,
        password: account.access_token,
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

      // Search all messages from last 3 days
      const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const searchCriteria = [['SINCE', since]];
      const fetchOptions = { bodies: [''], struct: true, markSeen: false };

      const messages = await connection.search(searchCriteria, fetchOptions);
      console.log(`Found ${messages.length} messages in inbox.`);

      for (const msg of messages) {
        const rawEmail = msg.parts.find(p => p.which === '').body;
        const parsed = await simpleParser(rawEmail);
        
        console.log(`- Subject: ${parsed.subject}`);
        console.log(`  From: ${parsed.from.text}`);
        console.log(`  MsgId: ${parsed.messageId}`);
        console.log(`  In-Reply-To: ${parsed.inReplyTo}`);
        console.log(`  References: ${parsed.references}`);

        let refIds = [];
        if (parsed.inReplyTo) refIds = refIds.concat(Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo : [parsed.inReplyTo]);
        if (parsed.references) refIds = refIds.concat(Array.isArray(parsed.references) ? parsed.references : [parsed.references]);

        for (const refId of refIds) {
          const cleanRefId = refId.replace(/^<|>$/g, '');
          const match = sent.find(s => s.message_id === refId || s.message_id === `<${cleanRefId}>`);
          if (match) {
            console.log(`  ✅ MATCH FOUND! Matches DB ID: ${match.id}`);
          }
        }
      }
    } catch(err) {
      console.error('  ❌ Error:', err.message);
    } finally {
      if (connection) connection.end();
    }
  }
}

diagnose().catch(console.error);
