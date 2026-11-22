import { route, verifySession, validateFile, createUploadSession, HttpError, MAX_FILES_PER_REQUEST } from './_lib.js';

// Body: { token, files: [{ name, type, size }] }  (at most 20 files per request)
// Returns: { uploads: [{ uploadUrl }] } in the same order.
export default route('POST', async ({ body, origin }) => {
  const { sid } = verifySession(body.token);
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'No files.');
  if (files.length > MAX_FILES_PER_REQUEST) throw new HttpError(400, `At most ${MAX_FILES_PER_REQUEST} files per request.`);

  const offset = Number.isInteger(body.offset) && body.offset >= 0 && body.offset < 10000 ? body.offset : 0;
  const checked = files.map((f, i) => validateFile(f, offset + i));
  const urls = await Promise.all(checked.map((v) => createUploadSession(v, sid, origin)));
  return { uploads: urls.map((uploadUrl) => ({ uploadUrl })) };
}, { limitPerMinute: 40 });
