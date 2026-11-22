#!/usr/bin/env node
// One-time setup, run on your own computer:  npm run setup-google
// 1. Signs in to the church's Google account (only asks for permission to manage files THIS app creates).
// 2. Creates the private "documentary photos" folder in that Google Drive.
// 3. Saves all 5 secret settings to "vercel.env" (never shown on screen), ready to import into Vercel.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import readline from 'node:readline/promises';

const FOLDER_NAME = 'Pastor Dr. Martin Appiah – Documentary Photos';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const OUT_FILE = path.resolve('vercel.env');
const ERR_FILE = path.resolve('setup-error.txt');
try { fs.unlinkSync(ERR_FILE); } catch {}

// Shows a problem in a TextEdit window as well as Terminal (never includes any keys).
function fail(message) {
  const text = 'COP Documentary Upload – setup problem\n\n' + message + '\n';
  console.error('\n✖ ' + message + '\n');
  try {
    fs.writeFileSync(ERR_FILE, text);
    if (process.platform === 'darwin') exec(`open -e "${ERR_FILE}"`, () => {});
  } catch {}
  process.exit(1);
}
process.on('uncaughtException', (e) => fail(e.message));
process.on('unhandledRejection', (e) => fail(String(e?.message || e)));

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write(' (received)\n');
          // drop terminal paste markers and any invisible characters picked up while copying
          resolve(value.replace(/\x1b\[20[01]~/g, '').replace(/[^\x21-\x7e]/g, ''));
          return;
        }
        if (c === '\u0003') process.exit(1); // Ctrl+C
        if (c === '\u007f') { value = value.slice(0, -1); continue; } // Backspace
        value += c;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}

let clientId = process.env.GOOGLE_CLIENT_ID || '';
if (!clientId) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  clientId = (await rl.question('Paste your Google OAuth Client ID: ')).trim();
  rl.close();
}
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || await askHidden('Paste your Google OAuth Client secret (it stays hidden), then press Enter: ');
if (!clientId || !clientSecret) fail('The Client ID and Client secret are both required.');
if (/apps\.googleusercontent\.com$|^\d{6,}-/.test(clientSecret)) {
  fail('What you pasted is the Client ID, not the Client secret.\n\nIn Google Cloud → Clients → your client, click "+ Add secret". Copy the new value that starts with GOCSPX- using the copy icon right next to it (not the Client ID\'s copy icon), then run the setup again.');
}
// Safe to show: Google itself displays the last 4 characters in the Client secrets list.
console.log(`Secret received: ${clientSecret.slice(0, 7)}…${clientSecret.slice(-4)} (${clientSecret.length} characters).`);
console.log('Check the last 4 characters match one of the secrets listed under "Client secrets" in Google Cloud.');
if (!clientSecret.startsWith('GOCSPX-')) console.log('⚠ Google secrets normally start with GOCSPX- — this one does not, so it is probably the wrong value.');

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ok ? '<h2>Done. You can close this tab and go back to the terminal.</h2>' : '<h2>Sign-in failed. Please run the setup again.</h2>');
    server.close();
    ok ? resolve({ code: url.searchParams.get('code'), redirect: server._redirect }) : reject(new Error(url.searchParams.get('error') || 'Sign-in failed'));
  });
  // Fixed port, so it also works with a "Web application" client that lists http://127.0.0.1:53682
  server.on('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? 'Port 53682 is busy. Close other setup windows and try again.' : e.message)));
  server.listen(53682, '127.0.0.1', () => {
    const port = server.address().port;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    server._redirect = `http://127.0.0.1:${port}`;
    console.log('\nYour browser is opening. Sign in with the CHURCH Google account that should store the photos.');
    console.log('If it does not open, copy this link into your browser:\n\n' + auth + '\n\nWaiting for sign-in…');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${opener} "${auth}"`, () => {});
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({
    code: code.code, client_id: clientId, client_secret: clientSecret, redirect_uri: code.redirect,
    grant_type: 'authorization_code', code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  const why = tokens.error_description || tokens.error || ('HTTP ' + tokenRes.status);
  fail('Google sign-in did not finish: ' + why + '\n\n' + (/invalid_client|unauthorized|client secret/i.test(why)
    ? 'The Client secret does not match this Client ID. In Google Cloud → Google Auth Platform → Clients, open the client ending in …3o38, click "Add secret", copy the NEW secret with its copy button (it starts with GOCSPX-), and run the setup again.'
    : 'Remove "COP Documentary Upload" at https://myaccount.google.com/permissions (signed in as the church account) and run the setup again.'));
}

const folderRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
});
const folder = await folderRes.json();
if (!folderRes.ok) {
  const why = folder.error?.message || ('HTTP ' + folderRes.status);
  fail('Signed in, but could not create the Drive folder: ' + why + '\n\n' + (/not been used|disabled|accessNotConfigured/i.test(why)
    ? 'Fix: in Google Cloud, search "Google Drive API" and click Enable. Wait 1 minute, then run the setup again.'
    : 'Please send a screenshot of this message.'));
}

const lines = [
  'GOOGLE_CLIENT_ID=' + clientId,
  'GOOGLE_CLIENT_SECRET=' + clientSecret,
  'GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token,
  'DRIVE_FOLDER_ID=' + folder.id,
  'SESSION_SECRET=' + crypto.randomBytes(48).toString('base64url'),
];
fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', { mode: 0o600 });

console.log('\n(setup script version 3)');
console.log('\n✔ Signed in and created the folder "' + FOLDER_NAME + '"');
console.log('  Open it in Google Drive: ' + folder.webViewLink);
console.log('\n✔ Saved the 5 secret settings to: ' + OUT_FILE);
console.log('\nLast step: Vercel → cop-documentary-upload → Settings → Environment Variables');
console.log('→ "Import .env" → choose that file → tick Production → Save → then Redeploy.');
console.log('After importing, delete vercel.env. Never send it to anyone.\n');
if (process.platform === 'darwin') exec(`open -R "${OUT_FILE}"`, () => {});
