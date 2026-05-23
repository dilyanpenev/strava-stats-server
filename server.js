// ============================================================
// server.js — Strava OAuth handler for Parkrun → Strava
// Deployed on Render (free tier)
//
// Routes:
//   GET /          → landing page (Connect with Strava)
//   GET /callback  → Strava redirects here after auth
//   GET /success   → shown after successful connection
//   GET /error     → shown if something goes wrong
// ============================================================

const http  = require('http');
const https = require('https');
const url   = require('url');

// --- Config ---
// Set these as environment variables in Render, never hardcode secrets
const CONFIG = {
  STRAVA_CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  APPS_SCRIPT_URL:      process.env.APPS_SCRIPT_URL,      // your /exec URL
  APPS_SCRIPT_SECRET:   process.env.APPS_SCRIPT_SECRET,   // a random password you choose
  PORT:                 process.env.PORT || 3000,
};

// The public URL of this server on Render — set as env var after first deploy
const BASE_URL = process.env.BASE_URL || 'http://localhost:' + CONFIG.PORT;


// --- Strava OAuth helpers ---

function getStravaAuthUrl() {
  const redirectUri = BASE_URL + '/callback';
  return 'https://www.strava.com/oauth/authorize'
    + '?client_id='     + CONFIG.STRAVA_CLIENT_ID
    + '&redirect_uri='  + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&approval_prompt=auto'
    + '&scope=activity%3Aread_all%2Cactivity%3Awrite';
}

// Exchanges an auth code for tokens by calling Strava's token endpoint.
function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id:     CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      code:          code,
      grant_type:    'authorization_code',
    });

    const options = {
      hostname: 'www.strava.com',
      path:     '/oauth/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Strava token exchange failed: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Fetches the full athlete profile using the access token.
// This includes the email address which Strava omits from the token response.
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
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Failed to fetch athlete profile: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Sends the token data to Apps Script to store in PropertiesService.
function sendTokensToAppsScript(email, accessToken, refreshToken, expiresAt, athleteId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      secret:        CONFIG.APPS_SCRIPT_SECRET,
      email:         email,
      accessToken:   accessToken,
      refreshToken:  refreshToken,
      expiresAt:     expiresAt,
      athleteId:     athleteId,
    });

    const appsScriptUrl = new URL(CONFIG.APPS_SCRIPT_URL);

    const options = {
      hostname: appsScriptUrl.hostname,
      path:     appsScriptUrl.pathname + appsScriptUrl.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
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


// --- HTML pages ---

function landingPage() {
  const authUrl = getStravaAuthUrl();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parkrun → Strava</title>
<style>
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
    max-width: 440px;
    width: 100%;
    text-align: center;
    box-shadow: 0 2px 16px rgba(0,0,0,0.08);
  }
  .logo { font-size: 40px; margin-bottom: 16px; }
  h1 { font-size: 24px; font-weight: 600; color: #1a1a1a; margin-bottom: 8px; }
  p  { font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 8px; }
  .steps {
    text-align: left;
    background: #f9f9f9;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 24px 0;
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
  }
  .note { font-size: 13px; color: #999; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🏃</div>
  <h1>Parkrun → Strava</h1>
  <p>Automatically update your Strava activity description with your official parkrun results.</p>
  <div class="steps">
    <b>How it works:</b><br>
    1. Connect your Strava account below<br>
    2. Forward your parkrun results email<br>
    3. Your activity updates automatically
  </div>
  <a href="${authUrl}" class="btn">Connect with Strava</a>
  <p class="note">We only request permission to read and update your activities.</p>
</div>
</body>
</html>`;
}

function successPage(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connected — Parkrun → Strava</title>
<style>
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
    max-width: 440px;
    width: 100%;
    text-align: center;
    box-shadow: 0 2px 16px rgba(0,0,0,0.08);
  }
  .tick { font-size: 48px; margin-bottom: 16px; }
  h1   { font-size: 24px; font-weight: 600; color: #1a1a1a; margin-bottom: 8px; }
  p    { font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 16px; }
  .address-box {
    background: #f0f7ff;
    border: 1px solid #c0d8f0;
    border-radius: 10px;
    padding: 16px 20px;
    font-family: monospace;
    font-size: 15px;
    color: #1a4a7a;
    margin: 16px 0 24px;
    word-break: break-all;
  }
  .note { font-size: 13px; color: #999; }
</style>
</head>
<body>
<div class="card">
  <div class="tick">✅</div>
  <h1>You're connected!</h1>
  <p>Your Strava account has been linked for <b>${email}</b>.</p>
  <p>After each parkrun, forward your results email to:</p>
  <div class="address-box">myparkrun.strava@gmail.com</div>
  <p>Your Strava activity will update automatically within minutes.</p>
  <p class="note">Forward from the same email address you use for Strava.</p>
</div>
</body>
</html>`;
}

function errorPage(reason) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error — Parkrun → Strava</title>
<style>
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
    max-width: 440px;
    width: 100%;
    text-align: center;
    box-shadow: 0 2px 16px rgba(0,0,0,0.08);
  }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1   { font-size: 24px; font-weight: 600; color: #1a1a1a; margin-bottom: 8px; }
  p    { font-size: 15px; color: #666; line-height: 1.6; margin-bottom: 24px; }
  .reason {
    background: #fff5f5;
    border: 1px solid #fcc;
    border-radius: 10px;
    padding: 14px 18px;
    font-size: 14px;
    color: #c00;
    margin-bottom: 24px;
  }
  .btn {
    display: inline-block;
    background: #FC4C02;
    color: #fff;
    text-decoration: none;
    font-size: 15px;
    font-weight: 600;
    padding: 12px 28px;
    border-radius: 10px;
  }
</style>
</head>
<body>
<div class="card">
  <div class="icon">⚠️</div>
  <h1>Something went wrong</h1>
  <p>We could not connect your Strava account.</p>
  <div class="reason">${reason}</div>
  <a href="/" class="btn">Try again</a>
</div>
</body>
</html>`;
}


// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const params   = parsed.query;

  // Landing page
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(landingPage());
    return;
  }

  // Strava OAuth callback
  if (pathname === '/callback') {
    if (params.error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(errorPage('Strava authorisation was denied.'));
      return;
    }

    if (!params.code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(errorPage('No authorisation code received from Strava.'));
      return;
    }

    try {
      // Exchange code for tokens
      const data    = await exchangeCodeForTokens(params.code);

      // Fetch full athlete profile — Strava often omits email from token response
      const athlete = await fetchAthleteProfile(data.access_token);
      const email   = athlete.email;

      if (!email) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(errorPage('Your Strava account does not have a verified email address. Please add one at strava.com/settings/profile and try again.'));
        return;
      }

      // Send tokens to Apps Script for storage
      await sendTokensToAppsScript(
        email,
        data.access_token,
        data.refresh_token,
        data.expires_at,
        athlete.id,
      );

      // Show success page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(successPage(email));

    } catch (err) {
      console.error('Callback error:', err.message);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(errorPage('An unexpected error occurred: ' + err.message));
    }

    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(CONFIG.PORT, () => {
  console.log('Server running on port ' + CONFIG.PORT);
});