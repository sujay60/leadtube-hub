const imaps = require('imap-simple');
const { initDatabase, getDb } = require('./database/db');

async function test() {
  await initDatabase();
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE email="sujaybhaumik30@gmail.com"').get();
  const connection = await imaps.connect({
    imap: {
      user: account.email,
      password: account.access_token,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000
    }
  });
  await connection.openBox('INBOX');
  const msgs = await connection.search(['UNSEEN'], { bodies: ['HEADER', 'TEXT'] });
  if (msgs.length) {
    const headerPart = msgs[0].parts.find(p => p.which === 'HEADER');
    console.log(typeof headerPart.body);
    if (typeof headerPart.body === 'object') {
      console.log('Object keys:', Object.keys(headerPart.body));
      console.log('Object to string:', JSON.stringify(headerPart.body).slice(0, 100));
    } else {
      console.log('String length:', headerPart.body.length);
    }
  }
  connection.end();
}
test().catch(console.error);
