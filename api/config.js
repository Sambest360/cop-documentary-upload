import { route, MAX_FILE_MB, MAX_FILES_PER_REQUEST } from './_lib.js';

// Public settings the page needs. Contains no secrets.
export default route('GET', async () => ({
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
  maxFileMB: MAX_FILE_MB,
  maxFilesPerRequest: MAX_FILES_PER_REQUEST,
}), { limitPerMinute: 60 });
