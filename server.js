// ============================================================
// server.js — Strava OAuth handler for Parkrun → Strava
// Deployed on Render (free tier)
//
// Routes:
//   GET  /            → landing page (Connect with Strava)
//   GET  /callback    → Strava redirects here after auth
//   GET  /setup       → ask user for their parkrun email
//   POST /save-email  → save parkrun email and finalise setup
//   GET  /done        → all done page
//   GET  /error       → error page
// ============================================================

const http  = require('http');
const https = require('https');
const url   = require('url');

const CONFIG = {
  STRAVA_CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  APPS_SCRIPT_URL:      process.env.APPS_SCRIPT_URL,
  APPS_SCRIPT_SECRET:   process.env.APPS_SCRIPT_SECRET,
  FORWARD_ADDRESS:      process.env.FORWARD_ADDRESS || 'myparkrun.strava@gmail.com',
  PORT:                 process.env.PORT || 3000,
};

const BASE_URL = process.env.BASE_URL || 'http://localhost:' + CONFIG.PORT;


// --- Strava helpers ---

function getStravaAuthUrl() {
  const redirectUri = BASE_URL + '/callback';
  return 'https://www.strava.com/oauth/authorize'
    + '?client_id='     + CONFIG.STRAVA_CLIENT_ID
    + '&redirect_uri='  + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&approval_prompt=auto'
    + '&scope=read%2Cactivity%3Aread_all%2Cactivity%3Awrite';
}

function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id:     CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
    const options = {
      hostname: 'www.strava.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error('Token exchange failed: ' + data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchAthleteProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.strava.com',
      path:     '/api/v3/athlete',
      method:   'GET',
      headers:  { Authorization: 'Bearer ' + accessToken },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error('Fetch athlete failed: ' + data)));
    });
    req.on('error', reject);
    req.end();
  });
}

function sendToAppsScript(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ secret: CONFIG.APPS_SCRIPT_SECRET, ...payload });
    const appsScriptUrl = new URL(CONFIG.APPS_SCRIPT_URL);
    const options = {
      hostname: appsScriptUrl.hostname,
      path:     appsScriptUrl.pathname + appsScriptUrl.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Simple in-memory store for pending registrations
// Keyed by stravaEmail, holds tokens until parkrun email is submitted
const pending = {};


// --- Parse POST body ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // Try JSON first, then URL-encoded form
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
          resolve(JSON.parse(body));
        } else {
          const params = new URLSearchParams(body);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        }
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}


// --- HTML pages ---

const styles = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f5f5f5;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    padding: 48px 40px;
    max-width: 460px;
    width: 100%;
    text-align: center;
    box-shadow: 0 2px 16px rgba(0,0,0,0.08);
  }
  .icon { font-size: 40px; margin-bottom: 16px; }
  h1 { font-size: 24px; font-weight: 600; color: #1a1a1a; margin-bottom: 8px; }
  p  { font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 12px; }
  .steps {
    text-align: left;
    background: #f9f9f9;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 20px 0;
    font-size: 14px;
    color: #444;
    line-height: 2;
  }
  .btn {
    display: inline-block;
    background: #FC4C02;
    color: #fff;
    text-decoration: none;
    font-size: 16px;
    font-weight: 600;
    padding: 14px 32px;
    border-radius: 10px;
    margin-top: 8px;
    border: none;
    cursor: pointer;
    width: 100%;
  }
  .btn:hover { background: #e04400; }
  input[type=email] {
    width: 100%;
    padding: 12px 16px;
    font-size: 15px;
    border: 1.5px solid #ddd;
    border-radius: 10px;
    margin-bottom: 12px;
    outline: none;
  }
  input[type=email]:focus { border-color: #FC4C02; }
  .address-box {
    background: #f0f7ff;
    border: 1px solid #c0d8f0;
    border-radius: 10px;
    padding: 14px 18px;
    font-family: monospace;
    font-size: 14px;
    color: #1a4a7a;
    margin: 12px 0 20px;
    word-break: break-all;
  }
  .note { font-size: 13px; color: #999; margin-top: 14px; }
  .reason {
    background: #fff5f5;
    border: 1px solid #fcc;
    border-radius: 10px;
    padding: 14px 18px;
    font-size: 14px;
    color: #c00;
    margin-bottom: 20px;
  }
  label { display: block; text-align: left; font-size: 14px; color: #444; margin-bottom: 6px; font-weight: 500; }
`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Parkrun → Strava</title>
<style>${styles}</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function landingPage() {
  return page('Connect', `
    <div class="icon">🏃</div>
    <h1>Parkrun → Strava</h1>
    <p>Automatically update your Strava activity description with your official parkrun results.</p>
    <div class="steps">
      <b>How it works:</b><br>
      1. Connect your Strava account below<br>
      2. Tell us your parkrun email address<br>
      3. Forward your results email after each run<br>
      4. Your Strava activity updates automatically
    </div>
    <a href="${getStravaAuthUrl()}" class="btn">Connect with Strava</a>
    <p class="note">We only request permission to read and update your activities.</p>
  `);
}

function setupPage(sessionId, stravaEmail) {
  return page('One more step', `
    <div class="icon">📧</div>
    <h1>One more step</h1>
    <p>Strava connected for <b>${stravaEmail}</b>.</p>
    <p>What email address do your parkrun results get sent to? This may be different from your Strava email.</p>
    <form method="POST" action="/save-email">
      <input type="hidden" name="sessionId" value="${sessionId}">
      <label for="parkrunEmail">Parkrun results email</label>
      <input type="email" id="parkrunEmail" name="parkrunEmail" placeholder="you@example.com" required>
      <p class="note" style="text-align:left;margin-bottom:16px">This is the address parkrun sends your weekly results to.</p>
      <button type="submit" class="btn">Save &amp; finish</button>
    </form>
  `);
}

function donePage(parkrunEmail) {
  return page('All done', `
    <div class="icon">✅</div>
    <h1>You're all set!</h1>
    <p>After each parkrun, forward your results email to:</p>
    <div class="address-box">${CONFIG.FORWARD_ADDRESS}</div>
    <p>Forward from <b>${parkrunEmail}</b> and your Strava activity will update automatically within minutes.</p>
    <p class="note">You can close this page.</p>
  `);
}

function errorPage(reason) {
  return page('Error', `
    <div class="icon">⚠️</div>
    <h1>Something went wrong</h1>
    <p>We could not connect your Strava account.</p>
    <div class="reason">${reason}</div>
    <a href="/" class="btn">Try again</a>
  `);
}


// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const params   = parsed.query;

  const html = (content) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(content); };

  // Landing page
  if (pathname === '/' && req.method === 'GET') {
    return html(landingPage());
  }

  // Strava OAuth callback
  if (pathname === '/callback' && req.method === 'GET') {
    if (params.error) return html(errorPage('Strava authorisation was denied.'));
    if (!params.code) return html(errorPage('No authorisation code received from Strava.'));

    try {
      const data    = await exchangeCodeForTokens(params.code);
      const athlete = await fetchAthleteProfile(data.access_token);
      const stravaEmail = (athlete.email || '').toLowerCase().trim();

      if (!stravaEmail) {
        return html(errorPage('Could not retrieve your email from Strava. Please ensure your Strava account has a verified email at strava.com/settings/profile and try again.'));
      }

      // Generate a session ID to track this pending registration
      const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

      // Store tokens and strava email temporarily keyed by session ID
      pending[sessionId] = {
        stravaEmail,
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresAt:    data.expires_at,
        athleteId:    athlete.id,
      };

      // Ask user for their parkrun email only
      return html(setupPage(sessionId, stravaEmail));

    } catch (err) {
      console.error('Callback error:', err.message);
      return html(errorPage('An unexpected error occurred: ' + err.message));
    }
  }

  // Save parkrun email and finalise registration
  if (pathname === '/save-email' && req.method === 'POST') {
    try {
      const body         = await parseBody(req);
      const sessionId    = body.sessionId;
      const parkrunEmail = (body.parkrunEmail || '').toLowerCase().trim();

      if (!sessionId || !parkrunEmail) {
        return html(errorPage('Missing details. Please go back and try again.'));
      }

      const tokens = pending[sessionId];
      if (!tokens) {
        return html(errorPage('Session expired. Please <a href="/">start again</a>.'));
      }

      const stravaEmail = tokens.stravaEmail;

      // Send everything to Apps Script
      await sendToAppsScript({
        stravaEmail,
        parkrunEmail,
        accessToken:  tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt:    tokens.expiresAt,
        athleteId:    tokens.athleteId,
      });

      // Clean up pending store
      delete pending[sessionId];

      return html(donePage(parkrunEmail));

    } catch (err) {
      console.error('Save email error:', err.message);
      return html(errorPage('An unexpected error occurred: ' + err.message));
    }
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(CONFIG.PORT, () => {
  console.log('Server running on port ' + CONFIG.PORT);
});