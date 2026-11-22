(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body, hero: $('hero'), picker: $('picker'), zone: $('zone'), files: $('files'), camera: $('camera'),
    error: $('error'), tray: $('tray'), trayTitle: $('tray-title'), traySub: $('tray-sub'), grid: $('grid'),
    overallWrap: $('overall-wrap'), overall: $('overall'), overallFill: $('overall-fill'),
    actions: $('actions'), clear: $('clear'), upload: $('upload'), uploadLabel: $('upload-label'), retry: $('retry'),
    done: $('done'), doneTitle: $('done-title'), doneRef: $('done-ref'), again: $('again'), live: $('live'), ts: $('turnstile'),
  };

  const CONCURRENCY = 3;
  const MAX_ITEMS = 500;
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' };
  const OK_TYPES = new Set(Object.values(TYPES));

  const state = {
    items: [], phase: 'pick', nextId: 1, counter: 0, session: null, lastUploaded: 0,
    config: { maxFileMB: 25, maxFilesPerRequest: 20, turnstileSiteKey: null },
  };

  // ---------- helpers ----------
  const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const plural = (n) => (n === 1 ? '1 photo' : n + ' photos');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const announce = (msg) => { el.live.textContent = ''; setTimeout(() => { el.live.textContent = msg; }, 50); };

  function showError(msg) {
    el.error.textContent = msg || '';
    el.error.hidden = !msg;
  }

  function typeOf(file) {
    let t = (file.type || '').toLowerCase();
    if (t === 'image/jpg' || t === 'image/pjpeg') t = 'image/jpeg';
    if (OK_TYPES.has(t)) return t;
    const ext = ((file.name || '').match(/\.([a-z0-9]+)$/i) || [])[1];
    return TYPES[(ext || '').toLowerCase()] || '';
  }

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(path, body) {
    let r;
    try {
      r = await fetch(path, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'No internet connection. Please check your connection and try again.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- bot check (only if the site owner turned on Turnstile) ----------
  let tsWidget = null;
  let tsToken = null;
  let tsWaiters = [];
  let tsLoading = null;

  function loadTurnstile() {
    if (!state.config.turnstileSiteKey) return Promise.resolve();
    if (tsLoading) return tsLoading;
    tsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.onload = () => {
        tsWidget = window.turnstile.render(el.ts, {
          sitekey: state.config.turnstileSiteKey,
          appearance: 'interaction-only',
          callback: (t) => { tsToken = t; tsWaiters.splice(0).forEach((w) => w.resolve(t)); },
          'error-callback': () => { tsWaiters.splice(0).forEach((w) => w.reject(new ApiError(0, 'The security check could not load. Please refresh the page.'))); },
          'expired-callback': () => { tsToken = null; },
        });
        resolve();
      };
      s.onerror = () => reject(new ApiError(0, 'The security check could not load. Please refresh the page.'));
      document.head.appendChild(s);
    });
    return tsLoading;
  }

  async function turnstileToken() {
    await loadTurnstile();
    if (tsToken) { const t = tsToken; tsToken = null; return t; }
    return new Promise((resolve, reject) => {
      tsWaiters.push({ resolve, reject });
      setTimeout(() => reject(new ApiError(0, 'The security check is taking too long. Please refresh the page.')), 60000);
    }).then((t) => { tsToken = null; return t; });
  }

  async function ensureSession() {
    if (state.session && state.session.expiresAt - Date.now() > 10 * 60 * 1000) return state.session;
    const body = {};
    if (state.config.turnstileSiteKey) body.turnstileToken = await turnstileToken();
    state.session = await api('/api/session', body);
    if (tsWidget !== null && window.turnstile) window.turnstile.reset(tsWidget);
    return state.session;
  }

  // ---------- adding & removing photos ----------
  function addFiles(list) {
    if (state.phase === 'uploading') return;
    const maxBytes = state.config.maxFileMB * 1024 * 1024;
    const wrongType = [];
    const tooBig = [];
    let added = 0;
    const seen = new Set(state.items.map((i) => i.key));

    for (const file of Array.from(list || [])) {
      const type = typeOf(file);
      if (!type) { wrongType.push(file.name); continue; }
      if (file.size > maxBytes) { tooBig.push(file.name); continue; }
      if (!file.size) continue;
      const key = file.name + '|' + file.size + '|' + file.lastModified;
      if (seen.has(key)) continue;
      if (state.items.length >= MAX_ITEMS) { showError(`You can add up to ${MAX_ITEMS} photos at a time. Upload these first, then add more.`); break; }
      seen.add(key);
      const item = { id: state.nextId++, key, file, name: file.name, type, size: file.size, status: 'ready', loaded: 0, url: URL.createObjectURL(file) };
      item.el = buildItem(item);
      el.grid.appendChild(item.el.li);
      state.items.push(item);
      added++;
    }

    const notes = [];
    if (wrongType.length) notes.push(`${wrongType.length === 1 ? '1 file' : wrongType.length + ' files'} skipped because ${wrongType.length === 1 ? 'it isn\'t' : 'they aren\'t'} a photo (${wrongType.slice(0, 3).join(', ')}${wrongType.length > 3 ? '…' : ''}).`);
    if (tooBig.length) notes.push(`${plural(tooBig.length)} skipped because ${tooBig.length === 1 ? 'it is' : 'they are'} larger than ${state.config.maxFileMB} MB.`);
    if (notes.length) showError(notes.join(' ')); else if (added) showError('');
    if (added) announce(`${plural(added)} added. ${plural(state.items.length)} ready to upload.`);
    render();
  }

  function removeItem(item) {
    URL.revokeObjectURL(item.url);
    item.el.li.remove();
    state.items = state.items.filter((i) => i !== item);
    render();
  }

  function clearAll() {
    state.items.forEach((i) => URL.revokeObjectURL(i.url));
    state.items = [];
    el.grid.textContent = '';
    showError('');
    state.phase = 'pick';
    render();
  }

  const ICON_PHOTO = '<svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8FA8D6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>';
  const ICON_X = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_OK = '<svg role="img" aria-label="Uploaded" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_FAIL = '<svg role="img" aria-label="Failed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>';

  function buildItem(item) {
    const li = document.createElement('li');
    li.className = 'item';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = item.url;
    img.onerror = () => { img.remove(); thumb.insertAdjacentHTML('afterbegin', ICON_PHOTO); }; // e.g. HEIC on Chrome
    thumb.appendChild(img);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', 'Remove ' + item.name);
    remove.innerHTML = '<span>' + ICON_X + '</span>';
    remove.addEventListener('click', () => removeItem(item));
    thumb.appendChild(remove);

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.hidden = true;
    thumb.appendChild(badge);

    const mini = document.createElement('div');
    mini.className = 'mini';
    mini.hidden = true;
    const miniFill = document.createElement('span');
    mini.appendChild(miniFill);
    thumb.appendChild(mini);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name; // textContent: file names are never treated as HTML
    const status = document.createElement('span');
    status.className = 'status';

    li.append(thumb, name, status);
    return { li, remove, badge, mini, miniFill, status };
  }

  function paintItem(item) {
    const e = item.el;
    const pct = item.size ? Math.round((item.loaded / item.size) * 100) : 0;
    e.remove.hidden = !(state.phase === 'pick' && item.status === 'ready');
    e.li.classList.toggle('busy', item.status === 'uploading' || item.status === 'queued');
    e.mini.hidden = !(item.status === 'uploading' || item.status === 'queued');
    e.miniFill.style.width = pct + '%';
    e.badge.hidden = !(item.status === 'done' || item.status === 'failed');
    if (item.status === 'done' && e.badge.dataset.s !== 'done') { e.badge.className = 'badge ok'; e.badge.innerHTML = ICON_OK; e.badge.dataset.s = 'done'; }
    if (item.status === 'failed' && e.badge.dataset.s !== 'failed') { e.badge.className = 'badge fail'; e.badge.innerHTML = ICON_FAIL; e.badge.dataset.s = 'failed'; }
    e.status.classList.toggle('fail', item.status === 'failed');
    e.status.textContent =
      item.status === 'done' ? 'Uploaded' :
      item.status === 'failed' ? (item.error || 'Not uploaded') :
      item.status === 'uploading' ? pct + '%' :
      item.status === 'queued' ? 'Waiting…' : fmt(item.size);
  }

  // ---------- rendering ----------
  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }

  function paint() {
    const items = state.items;
    const n = items.length;
    const done = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const ready = items.filter((i) => i.status === 'ready').length;
    const uploading = state.phase === 'uploading';

    el.body.classList.toggle('has-files', n > 0);
    el.done.hidden = state.phase !== 'done';
    el.hero.hidden = state.phase === 'done';
    el.picker.hidden = state.phase !== 'pick';
    el.tray.hidden = state.phase === 'done' || n === 0;
    el.overallWrap.hidden = !uploading;
    el.clear.hidden = uploading;
    el.upload.hidden = uploading || ready === 0;
    el.retry.hidden = uploading || failed === 0;
    el.actions.hidden = uploading;

    if (uploading) {
      const total = items.reduce((a, i) => a + i.size, 0);
      const loaded = items.reduce((a, i) => a + (i.status === 'done' ? i.size : i.loaded), 0);
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      el.trayTitle.textContent = `Uploading… ${done} of ${n} done`;
      el.traySub.textContent = pct + '% complete';
      el.overallFill.style.width = pct + '%';
      el.overall.setAttribute('aria-valuenow', String(pct));
    } else if (failed) {
      el.trayTitle.textContent = `${plural(failed)} didn't upload`;
      el.traySub.textContent = `${done} uploaded. Check your internet connection, then press "Retry failed photos".`;
    } else {
      el.trayTitle.textContent = `${plural(n)} ready to upload`;
      el.traySub.textContent = `${fmt(items.reduce((a, i) => a + i.size, 0))} in total · you can still add more`;
    }
    el.uploadLabel.textContent = 'Upload ' + plural(ready);
    items.forEach(paintItem);

    if (state.phase === 'done') {
      el.doneTitle.textContent = `Thank you! ${plural(state.lastUploaded)} received.`;
      el.doneRef.textContent = state.session ? `Upload reference: ${state.session.sid}` : '';
    }
  }

  // ---------- uploading ----------
  function requestUrl(item) {
    if (item.urlPromise) return item.urlPromise;
    // Ask for upload links in small batches so 200 photos don't mean 200 requests.
    const batch = [item, ...state.items.filter((i) => i !== item && i.status === 'queued' && !i.urlPromise)]
      .slice(0, state.config.maxFilesPerRequest);
    const offset = state.counter;
    state.counter += batch.length;
    const p = ensureSession().then((s) => api('/api/upload-url', {
      token: s.token, offset,
      files: batch.map((i) => ({ name: i.name, type: i.type, size: i.size })),
    }));
    batch.forEach((i, idx) => { i.urlPromise = p.then((r) => r.uploads[idx].uploadUrl); });
    return item.urlPromise;
  }

  function put(item, url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.loaded = e.loaded; render(); } };
      xhr.onload = () => (xhr.status === 200 || xhr.status === 201 ? resolve() : reject(new ApiError(xhr.status, 'Upload failed.')));
      xhr.onerror = () => reject(new ApiError(0, 'Connection lost.'));
      xhr.ontimeout = () => reject(new ApiError(0, 'Connection timed out.'));
      xhr.timeout = 15 * 60 * 1000;
      xhr.send(item.file);
    });
  }

  async function uploadOne(item) {
    item.status = 'uploading';
    render();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = await requestUrl(item);
        await put(item, url);
        item.status = 'done';
        item.loaded = item.size;
        render();
        return;
      } catch (err) {
        item.urlPromise = null; // get a fresh link next time
        item.loaded = 0;
        if (err.status === 401) state.session = null;
        // Problems retrying won't fix:
        if ([403, 413, 415, 503, 507].includes(err.status)) { item.error = err.message; break; }
        item.error = err.status === 429 ? 'Busy, try again' : (err.status === 0 ? 'Connection lost' : 'Not uploaded');
        if (err.status === 429) await sleep(20000); else await sleep(1500 * (attempt + 1));
      }
    }
    item.status = 'failed';
    render();
  }

  async function runUpload(which) {
    const queue = state.items.filter((i) => i.status === which);
    if (!queue.length || state.phase === 'uploading') return;
    queue.forEach((i) => { i.status = 'queued'; i.error = ''; i.loaded = 0; i.urlPromise = null; });
    state.phase = 'uploading';
    showError('');
    render();
    announce(`Uploading ${plural(queue.length)}. Please keep this page open.`);

    try {
      await ensureSession();
    } catch (err) {
      queue.forEach((i) => { i.status = which; });
      state.phase = 'pick';
      showError(err.message);
      render();
      return;
    }

    const worker = async () => { let item; while ((item = queue.shift())) await uploadOne(item); };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const failed = state.items.filter((i) => i.status === 'failed');
    const done = state.items.filter((i) => i.status === 'done');
    if (failed.length) {
      state.phase = 'pick';
      const fatal = failed.find((i) => /full|unavailable|official|security/i.test(i.error || ''));
      showError(fatal ? fatal.error : `${plural(failed.length)} didn't upload. Your other photos are safe.`);
      announce(`${plural(done.length)} uploaded, ${plural(failed.length)} failed.`);
    } else {
      state.lastUploaded = done.length;
      state.phase = 'done';
      announce(`Thank you! ${plural(done.length)} received.`);
      requestAnimationFrame(() => el.doneTitle.focus());
    }
    render();
  }

  function startOver() {
    clearAll();
    state.counter = 0;
    requestAnimationFrame(() => el.files.focus());
  }

  // ---------- events ----------
  el.files.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  el.camera.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  el.upload.addEventListener('click', () => runUpload('ready'));
  el.retry.addEventListener('click', () => runUpload('failed'));
  el.clear.addEventListener('click', clearAll);
  el.again.addEventListener('click', startOver);

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (state.phase === 'pick' && ++dragDepth === 1) el.zone.classList.add('drag'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.zone.classList.remove('drag'); } });
  window.addEventListener('dragover', (e) => e.preventDefault()); // stop the browser opening the photo
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.zone.classList.remove('drag');
    if (state.phase === 'pick') addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.phase === 'uploading') { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- start ----------
  api('/api/config').then((c) => {
    state.config = Object.assign(state.config, c);
    document.querySelectorAll('.max-mb').forEach((n) => { n.textContent = String(state.config.maxFileMB); });
    if (state.config.turnstileSiteKey) loadTurnstile().catch(() => {});
  }).catch(() => { /* keep defaults; uploads will report problems */ });

  render();
})();
