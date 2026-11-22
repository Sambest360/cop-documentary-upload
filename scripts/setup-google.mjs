#!/usr/bin/env node
// One-time setup, run on your own computer:  npm run setup-google
// 1. Signs in to the church's Google account (only asks for permission to manage files THIS app creates).
// 2. Creates the private "documentary photos" folder in that Google Drive.
// 3. Prints all 5 secret settings, ready to paste into Vercel in one go.
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import readline from 'node:readline/promises';

const FOLDER_NAME = 'Pastor Dr. Martin Appiah – Documentary Photos';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const clientId = process.env.GOOGLE_CLIENT_ID || (await rl.question('Paste your Google OAuth Client ID: ')).trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await rl.question('Paste your Google OAuth Client secret: ')).trim();
rl.close();
if (!clientId || !clientSecret) { console.error('Client ID and secret are required.'); process.exit(1); }

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
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    server._redirect = `http://127.0.0.1:${port}`;
    console.log('\nOpen this link and sign in with the CHURCH Google account that should store the photos:\n\n' + auth + '\n');
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
  console.error('\nCould not get a refresh token:', tokens.error_description || tokens.error || tokenRes.status);
  console.error('Tip: remove this app at https://myaccount.google.com/permissions and run the setup again.');
  process.exit(1);
}

const folderRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
});
const folder = await folderRes.json();
if (!folderRes.ok) { console.error('\nCould not create the folder:', folder.error?.message || folderRes.status); process.exit(1); }

const sessionSecret = crypto.randomBytes(48).toString('base64url');

console.log('\n✔ Signed in and created the folder "' + FOLDER_NAME + '"');
console.log('  Open it in Google Drive: ' + folder.webViewLink);
console.log('\nNext: Vercel → cop-documentary-upload → Settings → Environment Variables.');
console.log('Copy the 5 lines between the dashes and paste them into the first "Key" box');
console.log('(Vercel fills in all 5 at once). Tick Production, then Save, then Redeploy.');
console.log('Keep these secret: do not post them anywhere or send them in chat.\n');
console.log('----------------------------------------');
console.log('GOOGLE_CLIENT_ID=' + clientId);
console.log('GOOGLE_CLIENT_SECRET=' + clientSecret);
console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
console.log('DRIVE_FOLDER_ID=' + folder.id);
console.log('SESSION_SECRET=' + sessionSecret);
console.log('----------------------------------------\n');
