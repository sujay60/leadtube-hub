const { google } = require('googleapis');
const { initDatabase, getDb } = require('./database/db');

async function test() {
  await initDatabase();
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE refresh_token != "app_password"').get();
  if(!account) return console.log('no account');

  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'https://leadtube.onrender.com/auth/google/callback');
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  try {
    const res = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:2d' });
    console.log('Messages found:', res.data.messages ? res.data.messages.length : 0);
    if(res.data.messages){
      for(let m of res.data.messages.slice(0, 10)) {
        const full = await gmail.users.messages.get({userId:'me', id:m.id, format:'metadata'});
        const headers = full.data.payload.headers;
        console.log('---');
        console.log('Subject:', headers.find(h=>h.name==='Subject')?.value);
        console.log('Message-ID:', headers.find(h=>h.name.toLowerCase()==='message-id')?.value);
        console.log('In-Reply-To:', headers.find(h=>h.name.toLowerCase()==='in-reply-to')?.value);
        console.log('References:', headers.find(h=>h.name.toLowerCase()==='references')?.value);
      }
    }
  } catch (err) {
    console.error('Gmail API Error:', err.message);
  }
}

test().catch(console.error);
