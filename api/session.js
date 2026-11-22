import { route, verifyTurnstile, issueSession, clientIp } from './_lib.js';

// Starts an anonymous upload session (after the optional bot check).
// Returns a signed token the page sends with each upload request. No names, no cookies.
export default route('POST', async ({ req, body }) => {
  await verifyTurnstile(body.turnstileToken, clientIp(req));
  return issueSession();
}, { limitPerMinute: 10 });
