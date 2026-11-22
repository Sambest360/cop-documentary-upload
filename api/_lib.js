// Shared helpers for the API routes. Files starting with "_" are not exposed as routes by Vercel.
import crypto from 'node:crypto';

export const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 25);
export const MAX_FILES_PER_REQUEST = 20;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const EXT_TO_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' };

export function env(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(500, `Server is not configured (${name} missing).`);
  return v;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

// Wrap a handler: method check, origin check, rate limit, uniform errors.
export function route(method, handler, { limitPerMinute = 30 } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== method) throw new HttpError(405, 'Method not allowed.');
      const origin = checkOrigin(req);
      rateLimit(clientIp(req), req.url || '', limitPerMinute);
      const body = method === 'POST' ? parseBody(req) : {};
      const out = await handler({ req, body, origin });
      send(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong. Please try again.' : err.message });
    }
  };
}

// Only our own site may call the API. Browsers always send Origin on POST / cross-site requests.
export function checkOrigin(req) {
  const allowed = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'Requests are only accepted from the official upload page.');
  return origin;
}

function parseBody(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { throw new HttpError(400, 'Invalid JSON.'); } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Invalid request.');
  return b;
}

export function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Best-effort, per-instance limiter. Add a Vercel Firewall rate-limit rule for a hard, global limit.
const hits = new Map();
function rateLimit(ip, path, perMinute) {
  const key = ip + '|' + path.split('?')[0];
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > 60_000) { hits.set(key, { start: now, n: 1 }); }
  else if (++rec.n > perMinute) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > 60_000) hits.delete(k);
}

// ---- Anonymous upload sessions: signed, short-lived tokens (no names, no cookies) ----
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function issueSession() {
  const payload = { sid: crypto.randomBytes(4).toString('hex').toUpperCase(), exp: Date.now() + SESSION_TTL_MS };
  const body = b64u(JSON.stringify(payload));
  return { token: body + '.' + sign(body), sid: payload.sid, expiresAt: payload.exp };
}

export function verifySession(token) {
  if (typeof token !== 'string' || token.length > 300) throw new HttpError(401, 'Session expired. Please try again.');
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new HttpError(401, 'Session expired. Please try again.');
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new HttpError(401, 'Session expired. Please try again.');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new HttpError(401, 'Session expired. Please try again.'); }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now() || !/^[0-9A-F]{8}$/.test(payload.sid)) {
    throw new HttpError(401, 'Session expired. Please try again.');
  }
  return payload;
}

function sign(body) {
  const secret = env('SESSION_SECRET');
  if (secret.length < 32) throw new HttpError(500, 'Server is not configured (SESSION_SECRET too short).');
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

// ---- Bot check (Cloudflare Turnstile), optional ----
export async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return; // not enabled
  if (typeof token !== 'string' || !token || token.length > 4096) throw new HttpError(400, 'Please complete the security check.');
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await r.json().catch(() => ({}));
  if (!data.success) throw new HttpError(403, 'Security check failed. Please refresh the page and try again.');
}

// ---- File validation ----
export function validateFile(f, index) {
  if (!f || typeof f !== 'object') throw new HttpError(400, 'Invalid file.');
  const rawName = typeof f.name === 'string' ? f.name : '';
  const ext = (rawName.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1]?.toLowerCase() || '';
  let type = typeof f.type === 'string' ? f.type.toLowerCase() : '';
  if (!type && EXT_TO_TYPE[ext]) type = EXT_TO_TYPE[ext]; // some phones send HEIC with no type
  if (!ALLOWED_TYPES[type]) throw new HttpError(415, `"${shorten(rawName)}" is not a supported photo. Please upload JPG, PNG, HEIC, WEBP or GIF.`);
  const size = Number(f.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Invalid file size.');
  if (size > MAX_FILE_MB * 1024 * 1024) throw new HttpError(413, `"${shorten(rawName)}" is larger than ${MAX_FILE_MB} MB.`);
  return { type, size, ext: ALLOWED_TYPES[type], base: safeBase(rawName), index };
}

function shorten(s) { return String(s).slice(0, 60); }

function safeBase(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  const clean = base.normalize('NFKD').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return clean || 'photo';
}

export function driveFileName(v, sid, now = new Date()) {
  // e.g. 2026-11-22_1432_7F3A9C21_03_IMG-0042.jpg (time in South Africa)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const stamp = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
  return `${stamp}_${sid}_${String(v.index + 1).padStart(2, '0')}_${v.base}.${v.ext}`;
}

// ---- Google Drive ----
let cachedToken = null;

export async function googleAccessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    console.error('Google token refresh failed', r.status, data.error);
    throw new HttpError(503, 'Uploads are temporarily unavailable. Please contact the media team.');
  }
  cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

// Creates a resumable upload session for ONE file and returns its upload URL.
// The URL only lets the browser send the bytes of that one file (of exactly the declared size)
// into the folder. It cannot list, read or delete anything in Drive.
export async function createUploadSession(v, sid, origin) {
  const token = await googleAccessToken();
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': v.type,
      'X-Upload-Content-Length': String(v.size),
      Origin: origin, // lets the visitor's browser upload directly (CORS)
    },
    body: JSON.stringify({
      name: driveFileName(v, sid),
      parents: [env('DRIVE_FOLDER_ID')],
      mimeType: v.type,
      description: `Uploaded through the documentary photo page. Upload reference: ${sid}`,
      appProperties: { uploadRef: sid },
    }),
  });
  const url = r.headers.get('location');
  if (!r.ok || !url) {
    const detail = await r.text().catch(() => '');
    console.error('Drive session failed', r.status, detail.slice(0, 500));
    if (r.status === 403 && /storageQuota/i.test(detail)) throw new HttpError(507, 'The photo folder is full. Please contact the media team.');
    throw new HttpError(502, 'Could not start the upload. Please try again.');
  }
  return url;
}
