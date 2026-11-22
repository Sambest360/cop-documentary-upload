import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.GOOGLE_REFRESH_TOKEN = 'rtoken';
process.env.DRIVE_FOLDER_ID = 'folder123';
process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.ALLOWED_ORIGINS = 'https://site.example';

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
  }
  if (String(url).startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
    return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + calls.length } });
  }
  if (String(url).startsWith('https://challenges.cloudflare.com')) {
    const token = opts.body.get('response');
    return new Response(JSON.stringify({ success: token === 'good' }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + url);
};

const session = (await import('../api/session.js')).default;
const uploadUrl = (await import('../api/upload-url.js')).default;
const config = (await import('../api/config.js')).default;

let ipCounter = 0;
function call(handler, { method = 'POST', origin = 'https://site.example', body, ip } = {}) {
  const req = {
    method, url: '/api/x', body,
    headers: { origin, 'content-type': 'application/json', 'x-real-ip': ip || '10.0.0.' + ++ipCounter },
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(s) { resolve({ status: this.statusCode, body: JSON.parse(s), headers: this.headers }); },
    };
    handler(req, res);
  });
}

beforeEach(() => { calls.length = 0; delete process.env.TURNSTILE_SECRET_KEY; });

test('config is public and has no secrets', async () => {
  const r = await call(config, { method: 'GET' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['maxFileMB', 'maxFilesPerRequest', 'turnstileSiteKey']);
  assert.equal(r.headers['cache-control'], 'no-store');
  // same-origin GETs carry no Origin header in real browsers
  assert.equal((await call(config, { method: 'GET', origin: null })).status, 200);
});

test('missing settings give a friendly error, not variable names', async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  const r = await call(session, { body: {} });
  process.env.SESSION_SECRET = saved;
  assert.equal(r.status, 503);
  assert.ok(!/SESSION_SECRET/.test(r.body.error));
});

test('rejects other websites', async () => {
  assert.equal((await call(session, { origin: 'https://evil.example', body: {} })).status, 403);
  assert.equal((await call(session, { origin: null, body: {} })).status, 403);
});

test('rejects wrong method', async () => {
  assert.equal((await call(session, { method: 'GET' })).status, 405);
});

test('full flow: session then upload links', async () => {
  const s = await call(session, { body: {} });
  assert.equal(s.status, 200);
  assert.match(s.body.sid, /^[0-9A-F]{8}$/);

  const r = await call(uploadUrl, { body: { token: s.body.token, offset: 0, files: [
    { name: 'IMG_0042.JPG', type: 'image/jpeg', size: 3_000_000 },
    { name: '../../etc/<script>x.heic', type: '', size: 1000 },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.uploads.length, 2);
  assert.ok(r.body.uploads[0].uploadUrl.startsWith('https://www.googleapis.com/upload/'));

  const driveCalls = calls.filter((c) => c.url.startsWith('https://www.googleapis.com/upload'));
  assert.equal(driveCalls.length, 2);
  const meta0 = JSON.parse(driveCalls[0].opts.body);
  const meta1 = JSON.parse(driveCalls[1].opts.body);
  assert.deepEqual(meta0.parents, ['folder123']);
  assert.match(meta0.name, new RegExp(`^\\d{4}-\\d\\d-\\d\\d_\\d{4}_${s.body.sid}_01_IMG_0042\\.jpg$`));
  assert.match(meta1.name, new RegExp(`_${s.body.sid}_02_scriptx\\.heic$`)); // path + markup stripped
  assert.equal(meta1.mimeType, 'image/heic');
  assert.equal(driveCalls[0].opts.headers.Origin, 'https://site.example');
  assert.equal(driveCalls[0].opts.headers['X-Upload-Content-Length'], '3000000');
});

test('rejects tampered or missing session token', async () => {
  const s = await call(session, { body: {} });
  const [body, sig] = s.body.token.split('.');
  const forged = Buffer.from(JSON.stringify({ sid: 'AAAAAAAA', exp: Date.now() + 1e9 })).toString('base64url') + '.' + sig;
  const files = [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }];
  assert.equal((await call(uploadUrl, { body: { token: forged, files } })).status, 401);
  assert.equal((await call(uploadUrl, { body: { files } })).status, 401);
  assert.equal((await call(uploadUrl, { body: { token: body + '.bad', files } })).status, 401);
});

test('rejects non-photos, oversize and too many files', async () => {
  const { body: { token } } = await call(session, { body: {} });
  assert.equal((await call(uploadUrl, { body: { token, files: [{ name: 'x.exe', type: 'application/x-msdownload', size: 10 }] } })).status, 415);
  assert.equal((await call(uploadUrl, { body: { token, files: [{ name: 'x.svg', type: 'image/svg+xml', size: 10 }] } })).status, 415);
  assert.equal((await call(uploadUrl, { body: { token, files: [{ name: 'x.jpg', type: 'image/jpeg', size: 26 * 1024 * 1024 }] } })).status, 413);
  const many = Array.from({ length: 21 }, (_, i) => ({ name: i + '.jpg', type: 'image/jpeg', size: 10 }));
  assert.equal((await call(uploadUrl, { body: { token, files: many } })).status, 400);
  assert.equal(calls.filter((c) => c.url.includes('/upload/drive')).length, 0);
});

test('turnstile enforced when configured', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'ts';
  assert.equal((await call(session, { body: {} })).status, 400);
  assert.equal((await call(session, { body: { turnstileToken: 'bad' } })).status, 403);
  assert.equal((await call(session, { body: { turnstileToken: 'good' } })).status, 200);
});

test('rate limits a single visitor', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call(session, { body: {}, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('errors never leak internals', async () => {
  const saved = process.env.DRIVE_FOLDER_ID;
  const origFetch = globalThis.fetch;
  const { body: { token } } = await call(session, { body: {} });
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    return new Response('{"error":{"message":"secret internal detail"}}', { status: 500 });
  };
  const r = await call(uploadUrl, { body: { token, files: [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }] } });
  globalThis.fetch = origFetch;
  process.env.DRIVE_FOLDER_ID = saved;
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.body).includes('secret'));
});
