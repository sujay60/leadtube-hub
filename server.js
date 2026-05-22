/**
 * LeadTube Hub — Unified Production Server
 * 
 * Serves the Hub dashboard (static) + Channel Finder, Email Extractor,
 * Screenshot Extractor as static apps, and MailBlast (Bulk Email) as
 * a full Node.js backend — all from a single Express server.
 */

const path = require('path');

// Load environment variables (check root first, then Bulk Email dir)
require('dotenv').config();
if (!process.env.SESSION_SECRET) {
  require('dotenv').config({ path: path.join(__dirname, 'Bulk Email', '.env') });
}

const express = require('express');
const session = require('express-session');

// ── Import MailBlast (Bulk Email) modules ──
const { initDatabase } = require('./Bulk Email/database/db');
const authRoutes = require('./Bulk Email/routes/auth');
const templateRoutes = require('./Bulk Email/routes/templates');
const contactRoutes = require('./Bulk Email/routes/contacts');
const campaignRoutes = require('./Bulk Email/routes/campaigns');
const trackingRoutes = require('./Bulk Email/routes/tracking');
const inboxRoutes = require('./Bulk Email/routes/inbox');

// ── Import Hub Auth ──
const hubAuthRoutes = require('./hub-auth');

const app = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ──
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// ── Security: Block access to server-side source files ──
app.use((req, res, next) => {
  const blocked = [
    '/server.js', '/hub-server.js', '/hub-auth.js', '/package.json', '/package-lock.json',
    '/Dockerfile', '/fly.toml', '/.env', '/.dockerignore', '/.gitignore',
    '/Bulk Email/server.js', '/Bulk Email/routes/', '/Bulk Email/services/',
    '/Bulk Email/database/', '/Bulk Email/node_modules/', '/Bulk Email/.env',
    '/Bulk Email/package', '/Bulk Email/Dockerfile', '/Bulk Email/fly.toml',
    '/Bulk Email/uploads/', '/Bulk Email/mailblast.db',
    '/node_modules/'
  ];
  const decodedPath = decodeURIComponent(req.path);
  if (blocked.some(p => decodedPath === p || decodedPath.startsWith(p))) {
    return res.status(404).send('Not found');
  }
  next();
});

// ── Hub Auth Routes (must be BEFORE the auth guard) ──
app.use('/hub', hubAuthRoutes);

// ── MailBlast API Routes ──
app.use('/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/t', trackingRoutes);

// ── Creator Research Deep Intelligence Engine ──
// Helper: fetch a URL with browser-like headers
async function fetchPage(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// Helper: extract handle from YouTube URL
function extractHandle(channelUrl) {
  const m = channelUrl.match(/@([\w.-]+)/);
  if (m) return '@' + m[1];
  const parts = channelUrl.replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1];
  return last.startsWith('@') ? last : '@' + last;
}

// Helper: extract human name from social profile HTML via meta tags
function extractNameFromMeta(html) {
  const candidates = [];
  // og:title
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
  if (og) candidates.push(og[1]);
  // twitter:title
  const tw = html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="twitter:title"/i);
  if (tw) candidates.push(tw[1]);
  // title tag
  const tt = html.match(/<title>([^<]+)<\/title>/i);
  if (tt) candidates.push(tt[1]);

  for (const c of candidates) {
    // Clean and validate: looks like a human name (2-4 words, no special chars)
    const cleaned = c.replace(/[(@)\[\]|•·\-–—]/g, ' ')
                     .replace(/on Instagram|on X|Twitter|LinkedIn|TikTok|Facebook|\| .*$/gi, '')
                     .replace(/\s+/g, ' ').trim();
    const words = cleaned.split(' ').filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 4 && !/\d/.test(cleaned) &&
        !/photos|videos|posts|followers|login|sign/i.test(cleaned)) {
      return cleaned;
    }
  }
  return '';
}

// Helper: advanced heuristic name extraction from all collected intelligence
function heuristicExtractName(data) {
  const { channelName, email, socialNames, ytDescription, videoDescriptions } = data;

  // 1. Check socialNames first (most reliable — scraped from actual profiles)
  if (socialNames && socialNames.length > 0) {
    for (const name of socialNames) {
      if (name && name.split(' ').length >= 2 && name.split(' ').length <= 4) {
        return name;
      }
    }
  }

  // 2. Look for name patterns in YouTube description
  const allText = [ytDescription, ...(videoDescriptions || [])].join(' ');
  // "I'm [Name]", "My name is [Name]", "hosted by [Name]", "Hi, I'm [Name]"
  const introPatterns = [
    /(?:I'm|I am|my name is|hosted by|presented by|created by|run by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g,
    /(?:Hi!?\s*,?\s*)?(?:I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /(?:About|Meet)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g,
  ];
  for (const pattern of introPatterns) {
    let m;
    while ((m = pattern.exec(allText)) !== null) {
      const candidate = m[1].trim();
      if (candidate.split(' ').length >= 2 && !/Official|Channel|Subscribe|YouTube/i.test(candidate)) {
        return candidate;
      }
    }
  }

  // 3. Check for names inside brackets in channel name: "Dr. Boz [Annette Bosworth]"
  const bracketMatch = channelName.match(/[\[(]([^\])]+)[\])]/);
  if (bracketMatch) {
    const inner = bracketMatch[1].trim();
    if (inner.split(/\s+/).length <= 3 && !/\d/.test(inner)) {
      return inner;
    }
  }

  // 4. Try email address parsing
  if (email) {
    const firstEmail = email.split(/[,;\s]+/)[0];
    const local = firstEmail.split('@')[0].toLowerCase()
      .replace(/[0-9]/g, '');
    // dot/underscore separated: ruby.granger or ruby_granger
    const parts = local.split(/[._-]/);
    if (parts.length === 2 && parts[0].length > 2 && parts[1].length > 2 &&
        !/info|support|contact|hello|admin|sales|partner|business|noreply/i.test(local)) {
      return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    }
  }

  // 5. Clean channel name — if it looks like a human name
  let clean = channelName
    .replace(/[\[(].*?[\])]/g, '')  // remove bracket content
    .replace(/Official|Channel|Vlogs?|TV|Podcast|Show|Golf|Real\s*Estate|Dubai|Live/gi, '')
    .replace(/\bMD\b|\bPhD\b|\bPGA\b|\bDr\.?\b|\bMr\.?\b|\bMs\.?\b|\bMrs\.?\b/gi, '')
    .replace(/[^a-zA-Z\s'-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(w => w.length > 1);
  if (words.length >= 2 && words.length <= 3 &&
      !/church|ministries|club|hub|news|media|corp|company|agency|group|tips|health|fitness/i.test(clean)) {
    return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // 6. Org/brand detection
  if (/church|ministries|association|club|hub|news|media|tv|corp|company|group|official/i.test(channelName)) {
    return 'Organization';
  }

  return '';
}

app.post('/api/research-channel', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { channelUrl, channelName, email, socialLinks, ytApiKey, geminiApiKey } = req.body;
  if (!channelUrl) {
    return res.status(400).json({ error: 'Channel URL is required' });
  }

  const handle = extractHandle(channelUrl);
  console.log(`[Creator Research] ═══ Deep research started for: ${channelName || handle} ═══`);

  // Collect all intelligence signals
  const intel = {
    channelName: channelName || '',
    email: email || '',
    csvSocials: socialLinks || '',
    ytTitle: '',
    ytDescription: '',
    videoDescriptions: [],
    scrapedDescription: '',
    scrapedSocials: [],
    socialNames: []
  };

  // ── PHASE 1: YouTube Data API (most reliable structured data) ──
  if (ytApiKey) {
    try {
      console.log(`  [Phase 1] YouTube Data API — resolving channel by handle ${handle}`);
      const handleClean = handle.replace('@', '');
      const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings&forHandle=${handleClean}&key=${ytApiKey}`;
      const chResp = await fetch(chUrl);
      const chData = await chResp.json();

      if (chData.items && chData.items.length > 0) {
        const ch = chData.items[0];
        intel.ytTitle = ch.snippet?.title || '';
        intel.ytDescription = ch.snippet?.description || '';
        const channelId = ch.id;
        console.log(`  [Phase 1] Channel found: "${intel.ytTitle}" (${channelId})`);
        console.log(`  [Phase 1] Description: "${intel.ytDescription.substring(0, 200)}..."`);

        // Fetch 3 recent videos for their descriptions
        try {
          const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=3&key=${ytApiKey}`;
          const searchResp = await fetch(searchUrl);
          const searchData = await searchResp.json();
          if (searchData.items && searchData.items.length > 0) {
            const videoIds = searchData.items.map(v => v.id?.videoId).filter(Boolean).join(',');
            if (videoIds) {
              const vidUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds}&key=${ytApiKey}`;
              const vidResp = await fetch(vidUrl);
              const vidData = await vidResp.json();
              if (vidData.items) {
                intel.videoDescriptions = vidData.items.map(v => v.snippet?.description || '').filter(Boolean);
                console.log(`  [Phase 1] Fetched ${intel.videoDescriptions.length} video descriptions`);
              }
            }
          }
        } catch (vidErr) {
          console.warn(`  [Phase 1] Video fetch warning: ${vidErr.message}`);
        }
      } else {
        console.warn(`  [Phase 1] Channel not found via API, will rely on scraping`);
      }
    } catch (apiErr) {
      console.warn(`  [Phase 1] YouTube API error: ${apiErr.message}`);
    }
  } else {
    console.log(`  [Phase 1] No YouTube API key provided, skipping`);
  }



  const runLogs = [];
  runLogs.push(`[Phase 1] Resolving channel by handle: ${handle}`);

  // ── PHASE 1: Fetch Channel Info & Recent Videos via YouTube Data API v3 ──
  if (ytApiKey) {
    try {
      // Get Channel Info
      const chanUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${handle}&key=${ytApiKey}`;
      const chanResp = await fetch(chanUrl);
      const chanData = await chanResp.json();

      if (chanData.items && chanData.items.length > 0) {
        const item = chanData.items[0];
        intel.ytTitle = item.snippet.title;
        intel.ytDescription = item.snippet.description;
        intel.channelId = item.id;
        runLogs.push(`[Phase 1] ✓ Found channel title: "${intel.ytTitle}"`);

        // Fetch recent video descriptions
        const vUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${intel.channelId}&maxResults=3&order=date&type=video&key=${ytApiKey}`;
        const vResp = await fetch(vUrl);
        const vData = await vResp.json();

        if (vData.items) {
          intel.videoDescriptions = vData.items.map(v => v.snippet.description);
          runLogs.push(`[Phase 1] ✓ Fetched ${intel.videoDescriptions.length} recent video descriptions`);
        }
      } else {
        runLogs.push(`[Phase 1] Channel not found in API for handle ${handle}`);
      }
    } catch (apiErr) {
      runLogs.push(`[Phase 1] YouTube Data API warning: ${apiErr.message}`);
    }
  } else {
    runLogs.push(`[Phase 1] No YouTube API key provided, skipping API lookup`);
  }

  // ── PHASE 2: Page Scraping Fallback ──
  try {
    runLogs.push(`[Phase 2] Scraping YouTube page: ${channelUrl}`);
    const html = await fetchPage(channelUrl, 8000);
    
    // Scrape email or description or socials
    const descMatch = html.match(/"description":\s*\{"simpleText":\s*"([^"]+)"\}/) || html.match(/meta\s+name="description"\s+content="([^"]+)"/i);
    if (descMatch) {
      intel.scrapedDescription = descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      runLogs.push(`[Phase 2] ✓ Extracted description text (${intel.scrapedDescription.length} chars)`);
    }

    // Full About description from initialData JSON blob
    const aboutMatch = html.match(/"description":\s*\{"simpleText":\s*"([^"]{10,})"/);
    if (aboutMatch) {
      intel.ytDescription = intel.ytDescription || aboutMatch[1]
        .replace(/\\n/g, '\n').replace(/\\"/g, '"');
      runLogs.push(`[Phase 2] ✓ Extracted full About text (${intel.ytDescription.length} chars)`);
    }

    // Social links
    const socialPatterns = [
      /instagram\.com\/[\w._-]+/gi,
      /twitter\.com\/[\w_-]+/gi,
      /x\.com\/[\w_-]+/gi,
      /facebook\.com\/[\w._-]+/gi,
      /linkedin\.com\/(in|company)\/[\w_-]+/gi,
      /tiktok\.com\/@[\w._-]+/gi,
      /pinterest\.com\/[\w._-]+/gi
    ];
    const socials = new Set();
    for (const rx of socialPatterns) {
      const matches = html.match(rx);
      if (matches) matches.forEach(m => socials.add('https://' + m));
    }
    intel.scrapedSocials = [...socials];
    runLogs.push(`[Phase 2] ✓ Found ${intel.scrapedSocials.length} social links: ${JSON.stringify(intel.scrapedSocials)}`);
  } catch (scrapeErr) {
    runLogs.push(`[Phase 2] YouTube scrape warning: ${scrapeErr.message}`);
  }

  // ── PHASE 3: Social Profile Scraping (get real names from bios) ──
  const allSocials = [...new Set([
    ...intel.scrapedSocials,
    ...(intel.csvSocials ? intel.csvSocials.split(/[,;\s]+/).filter(Boolean) : [])
  ])];

  for (const socialUrl of allSocials.slice(0, 5)) { // max 5 profiles
    try {
      const cleanUrl = socialUrl.startsWith('http') ? socialUrl : 'https://' + socialUrl;
      runLogs.push(`[Phase 3] Scraping social profile: ${cleanUrl}`);
      const socialHtml = await fetchPage(cleanUrl, 8000);
      const extractedName = extractNameFromMeta(socialHtml);
      if (extractedName) {
        intel.socialNames.push(extractedName);
        runLogs.push(`[Phase 3] ✓ Extracted name from ${cleanUrl}: "${extractedName}"`);
      }
    } catch (socialErr) {
      runLogs.push(`[Phase 3] Social scrape warning for ${socialUrl}: ${socialErr.message}`);
    }
  }

  // ── PHASE 4: Gemini AI Deep Analysis (server-side, all signals combined) ──
  let hostName = '';
  let keyIssue = false;
  let keyErrorMsg = '';
  let anyModelSucceeded = false;

  if (geminiApiKey) {
    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-pro-latest'
    ];

    const prompt = `Who is the human host or creator of the YouTube channel ${handle} (Channel Name: "${intel.channelName}")? 

Use your internal knowledge to identify them.
Return ONLY their real full human name. 
Do not include any extra text, quotes, explanations, or punctuation.
If the channel is a brand, company, or organization with no specific individual host, return "Organization".
If you do not know the answer, return "Not Found".`;

    for (const modelName of modelsToTry) {
      try {
        runLogs.push(`[Phase 4] Calling Gemini (${modelName})...`);
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
        
        const geminiResp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          })
        });

        const geminiData = await geminiResp.json();

        if (geminiData.error) {
          const errMsg = geminiData.error.message || '';
          runLogs.push(`[Phase 4] Model ${modelName} returned API Error: "${errMsg}" (Code: ${geminiData.error.code})`);
          
          // Check for key-specific failure signatures (400 invalid, 403 suspended, 429 quota)
          if (
            geminiData.error.code === 403 || 
            geminiData.error.code === 429 || 
            geminiData.error.code === 400 ||
            errMsg.toLowerCase().includes('quota') ||
            errMsg.toLowerCase().includes('suspended') ||
            errMsg.toLowerCase().includes('permission') ||
            errMsg.toLowerCase().includes('api key not valid')
          ) {
            keyIssue = true;
            keyErrorMsg = errMsg;
          }
          continue; // Try next model
        }

        if (geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
          const rawText = geminiData.candidates[0].content.parts[0].text.trim();
          if (rawText) {
            hostName = rawText.replace(/[."'*]/g, '').trim();
            if (hostName.toLowerCase() === 'not found' || hostName.toLowerCase() === 'n/a') {
              hostName = '';
            } else {
              runLogs.push(`[Phase 4] ✓ Successful extraction with ${modelName}: "${hostName}"`);
              anyModelSucceeded = true;
              break; // Success! Exit loop
            }
          }
        }
      } catch (aiErr) {
        runLogs.push(`[Phase 4] Model ${modelName} Exception: ${aiErr.message}`);
      }
    }
  } else {
    runLogs.push(`[Phase 4] No Gemini API key provided, skipping AI analysis`);
  }

  // ── PHASE 5: Enhanced Heuristic Fallback ──
  if (!hostName) {
    runLogs.push(`[Phase 5] Running heuristic fallback extractor...`);
    hostName = heuristicExtractName(intel);
    runLogs.push(`[Phase 5] Heuristic result: "${hostName || 'None found'}"`);
  }

  runLogs.push(`[Complete] Final Host Name: "${hostName || 'Not Found'}"`);
  console.log(`[Creator Research] ═══ RESULT for ${intel.channelName || handle}: "${hostName}" ═══\n`);

  res.json({
    success: true,
    hostName: hostName || '',
    handle,
    logs: runLogs,
    geminiKeyFailed: keyIssue && !anyModelSucceeded,
    geminiKeyError: keyErrorMsg,
    debug: {
      ytTitle: intel.ytTitle,
      ytDescriptionLength: (intel.ytDescription || '').length,
      videoDescCount: intel.videoDescriptions.length,
      socialLinksFound: intel.scrapedSocials.length,
      socialNamesExtracted: intel.socialNames,
      scrapedDescription: (intel.scrapedDescription || '').substring(0, 200)
    }
  });
});

app.post('/api/test-gemini-key', async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ success: false, error: 'No key provided' });
  }

  const modelsToTry = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest'
  ];

  let lastError = 'All models failed to respond';

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'say hello' }] }] })
      });
      const data = await resp.json();

      if (data.error) {
        lastError = data.error.message;
        console.warn(`[Key Test] Model ${model} failed: ${lastError}`);
        continue;
      }

      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return res.json({ success: true, model });
      }
    } catch (e) {
      lastError = e.message;
      console.warn(`[Key Test] Exception on ${model}: ${lastError}`);
    }
  }

  res.json({ success: false, error: lastError });
});


// ── MailBlast API error handlers ──
app.use('/api', (err, req, res, next) => {
  console.error('API Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});
app.use('/auth', (err, req, res, next) => {
  console.error('Auth Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Auth Guard: Protect all pages behind login ──
app.use((req, res, next) => {
  // Allow login page, hub auth API, tracking pixels, and Google OAuth callbacks
  const publicPaths = ['/login.html', '/hub/', '/t/', '/auth/google', '/auth/google/callback'];
  const decodedPath = decodeURIComponent(req.path);
  if (publicPaths.some(p => decodedPath === p || decodedPath.startsWith(p))) {
    return next();
  }

  // If user is not logged in, redirect to login
  if (!req.session || !req.session.userId) {
    // For API requests, return 401 JSON
    if (decodedPath.startsWith('/api/') || decodedPath.startsWith('/auth/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/login.html');
  }

  next();
});

// ── MailBlast Static Files (CSS & JS for the Bulk Email frontend) ──
app.use('/css', express.static(path.join(__dirname, 'Bulk Email', 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'Bulk Email', 'public', 'js')));

// ── MailBlast Frontend (loaded inside Hub iframe) ──
app.get('/mailblast', (req, res) => {
  res.sendFile(path.join(__dirname, 'Bulk Email', 'public', 'index.html'));
});

// ── Hub Static Files (custom handler for URL-encoded paths with spaces) ──
const fs = require('fs');
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webp': 'image/webp'
};

app.use((req, res, next) => {
  // Only handle GET requests for static files
  if (req.method !== 'GET') return next();

  const urlWithoutQuery = req.path.split('?')[0];
  const decodedUrl = decodeURIComponent(urlWithoutQuery);
  const filePath = path.join(__dirname, decodedUrl === '/' ? 'index.html' : decodedUrl);

  // Safety: ensure the resolved path is within __dirname
  if (!filePath.startsWith(__dirname)) return next();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return next();
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.sendFile(filePath);
  });
});

// ── Start Server ──
async function start() {
  await initDatabase();

  // Start MailBlast background services
  const { startScheduler, checkOverdueFollowUps } = require('./Bulk Email/services/emailService');
  const { startInboxScanner } = require('./Bulk Email/services/inboxService');
  startScheduler();
  startInboxScanner();
  await checkOverdueFollowUps();

  app.listen(PORT, () => {
    console.log(`\n  🌟 LeadTube Hub running at http://localhost:${PORT}`);
    console.log(`  📧 MailBlast backend active at /mailblast`);
    console.log(`  🚀 Everything is unified and ready!\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
