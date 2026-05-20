const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const { initDatabase, getDb } = require('./database/db');

async function debug() {
  await initDatabase();
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM accounts WHERE refresh_token="app_password"').all();

  for (const account of accounts) {
    console.log('Checking account:', account.email);
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

      // Fetch ALL messages from the last 1 day (both SEEN and UNSEEN)
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const searchCriteria = [['SINCE', since]];
      const fetchOptions = { bodies: ['HEADER'], struct: true };

      const messages = await connection.search(searchCriteria, fetchOptions);
      console.log(`Found ${messages.length} messages since yesterday.`);

      for (const msg of messages) {
        const rawHeader = msg.parts.find(p => p.which === 'HEADER').body;
        const parsed = await simpleParser(rawHeader);
        
        console.log('---');
        console.log('Subject:', parsed.subject);
        console.log('Message-ID:', parsed.messageId);
        console.log('In-Reply-To:', parsed.inReplyTo);
        console.log('References:', parsed.references);

        // Try to match
        if (parsed.messageId) {
          let refIds = [];
          if (parsed.inReplyTo) refIds = refIds.concat(Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo : [parsed.inReplyTo]);
          if (parsed.references) refIds = refIds.concat(Array.isArray(parsed.references) ? parsed.references : [parsed.references]);

          for (const refId of refIds) {
            const cleanRefId = refId.replace(/^<|>$/g, '');
            const sentRecord = db.prepare(`SELECT * FROM campaign_emails WHERE message_id = ? OR message_id = ?`).get(refId, `<${cleanRefId}>`);
            if (sentRecord) {
              console.log('>>> MATCH FOUND IN DB! Campaign ID:', sentRecord.campaign_id);
            }
          }
        }
      }
    } catch(err) {
      console.error('Error:', err);
    } finally {
      if (connection) connection.end();
    }
  }
}
debug().catch(console.error);
