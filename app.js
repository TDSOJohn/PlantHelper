'use strict';

/* =========================================================================
   Plants — a personal plant database.

   The page and its data both come from a small server on the home network
   (server.py). localStorage is only a cache: it lets the app show your plants
   — and accept edits — while the server is rebooting or the Wi-Fi drops. Those
   edits are marked dirty and pushed on the next successful sync.
   ========================================================================= */

const K_PLANTS = 'plantdb.plants.v1';
const K_DIRTY  = 'plantdb.dirty.v1';

const API = new URL('api/plants', document.baseURI).href;
const TIMEOUT = 8000;

let plants = read(K_PLANTS, []);
let dirty  = read(K_DIRTY, false);   // local changes the server has not seen
let lastSync = null;
let lastError = '';

/* ---------- tiny helpers ---------- */

const $ = (sel) => document.querySelector(sel);

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    setStatus('Could not save to this device: ' + e.message, true);
  }
}

function persist() {
  write(K_PLANTS, plants);
}

const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const live = () => plants.filter((p) => !p.deletedAt);

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---------- status line ---------- */

let statusTimer = null;

function setStatus(text, isError, sticky) {
  const bar = $('#status');
  clearTimeout(statusTimer);
  if (!text) {
    bar.hidden = true;
    return;
  }
  bar.textContent = text;
  bar.classList.toggle('error', !!isError);
  bar.hidden = false;
  if (!sticky && !isError) {
    statusTimer = setTimeout(() => { bar.hidden = true; }, 2000);
  }
}

/* =========================================================================
   Sync

   The server merges whatever we send with whatever it already has, so there
   are no conflicts to resolve here and no revision to keep track of: send the
   local list, adopt the list that comes back.
   ========================================================================= */

/** Union of two lists by id; the most recently updated copy of each wins. */
function merge(local, remote) {
  const out = new Map();
  for (const p of remote.concat(local)) {
    if (!p || !p.id) continue;
    const seen = out.get(p.id);
    if (!seen || (p.updatedAt || '') >= (seen.updatedAt || '')) out.set(p.id, p);
  }
  return Array.from(out.values());
}

/** Order-independent fingerprint, to tell whether two lists say the same thing. */
const signature = (list) =>
  list.map((p) => p.id + ':' + (p.updatedAt || '') + (p.deletedAt ? ':x' : ''))
      .sort()
      .join('|');

async function request(method, payload) {
  const options = { method: method, cache: 'no-store', headers: { Accept: 'application/json' } };
  if (payload) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    options.signal = AbortSignal.timeout(TIMEOUT);
  }

  let res;
  try {
    res = await fetch(API, options);
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'the server did not answer' : 'no connection');
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch (e) { /* not JSON */ }
    throw new Error(detail || ('the server returned ' + res.status));
  }

  const doc = await res.json();
  if (!doc || !Array.isArray(doc.plants)) throw new Error('unexpected reply from the server');
  return doc;
}

let syncing = false;

async function sync(quiet) {
  if (syncing) return;
  syncing = true;
  if (!quiet) setStatus('Syncing…', false, true);

  try {
    let doc;
    if (dirty) {
      doc = await request('PUT', { plants: plants });
    } else {
      doc = await request('GET');
      // Nothing of ours is missing in the usual case; push only if it is.
      const merged = merge(plants, doc.plants);
      if (signature(merged) !== signature(doc.plants)) {
        doc = await request('PUT', { plants: merged });
      }
    }

    plants = doc.plants;
    persist();
    dirty = false;
    write(K_DIRTY, false);
    lastSync = new Date();
    lastError = '';
    refresh();
    setStatus(quiet ? '' : 'Synced', false);
  } catch (e) {
    lastError = e.message;
    setStatus('Not synced (' + e.message + ') — your changes are saved on this device.', true, true);
  } finally {
    syncing = false;
    if (route() === '/settings') renderSettings();
  }
}

/** Every change goes through here: save locally first, then try to sync. */
function commit() {
  persist();
  dirty = true;
  write(K_DIRTY, true);
  refresh();
  sync(true);
}

/* =========================================================================
   Routing — #/ , #/new , #/p/<id> , #/p/<id>/edit , #/settings
   ========================================================================= */

const VIEWS = ['list', 'detail', 'edit', 'settings'];

function route() {
  return (location.hash || '#/').slice(1);
}

function show(view, title, canGoBack) {
  for (const name of VIEWS) {
    $('#view-' + name).hidden = name !== view;
  }
  $('#title').textContent = title;
  $('#back').hidden = !canGoBack;
  window.scrollTo(0, 0);
}

/** Re-render after a background change, without clobbering a half-typed form. */
function refresh() {
  const path = route();
  if (path === '/new' || /\/edit$/.test(path)) return;
  render();
}

function render() {
  const path = route();

  if (path === '/settings') return renderSettings();
  if (path === '/new') return renderForm(null);

  const editMatch = path.match(/^\/p\/([^/]+)\/edit$/);
  if (editMatch) return renderForm(editMatch[1]);

  const detailMatch = path.match(/^\/p\/([^/]+)$/);
  if (detailMatch) return renderDetail(detailMatch[1]);

  return renderList();
}

/* ---------- list ---------- */

function renderList() {
  const items = live().sort(byName);
  const ul = $('#plant-list');
  ul.textContent = '';

  for (const p of items) {
    const a = document.createElement('a');
    a.href = '#/p/' + encodeURIComponent(p.id);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name;
    a.appendChild(name);

    if (p.water) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = p.water;
      a.appendChild(sub);
    }

    const li = document.createElement('li');
    li.appendChild(a);
    ul.appendChild(li);
  }

  $('#empty').hidden = items.length > 0;
  show('list', items.length ? `Plants (${items.length})` : 'Plants', false);
}

/* ---------- detail ---------- */

function renderDetail(id) {
  const p = plants.find((x) => x.id === id && !x.deletedAt);
  if (!p) {
    location.hash = '#/';
    return;
  }

  $('#d-name').textContent = p.name;

  fill($('#d-water'), p.water, 'No schedule recorded');
  fill($('#d-notes'), p.notes, 'No notes');

  $('#d-meta').textContent = p.createdAt ? 'Added ' + fmtDate(p.createdAt) : '';
  $('#d-edit').href = '#/p/' + encodeURIComponent(p.id) + '/edit';
  $('#d-delete').onclick = () => {
    if (!confirm(`Delete “${p.name}”?`)) return;
    p.deletedAt = new Date().toISOString();
    p.updatedAt = p.deletedAt;
    commit();
    location.hash = '#/';
  };

  show('detail', p.name, true);
}

function fill(node, text, placeholder) {
  node.textContent = text || placeholder;
  node.classList.toggle('blank', !text);
}

/* ---------- add / edit ---------- */

function renderForm(id) {
  const p = id ? plants.find((x) => x.id === id && !x.deletedAt) : null;
  if (id && !p) {
    location.hash = '#/';
    return;
  }

  const form = $('#form');
  form.reset();
  $('#f-name').value = p ? p.name : '';
  $('#f-water').value = p ? p.water || '' : '';
  $('#f-notes').value = p ? p.notes || '' : '';
  $('#f-name').classList.remove('invalid');

  form.onsubmit = (e) => {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    if (!name) {
      $('#f-name').classList.add('invalid');
      $('#f-name').focus();
      return;
    }

    const now = new Date().toISOString();
    const water = $('#f-water').value.trim();
    const notes = $('#f-notes').value.trim();

    if (p) {
      Object.assign(p, { name, water, notes, updatedAt: now });
    } else {
      plants.push({ id: uid(), name, water, notes, createdAt: now, updatedAt: now });
    }

    commit();
    location.hash = p ? '#/p/' + encodeURIComponent(p.id) : '#/';
  };

  $('#f-cancel').onclick = () => history.back();

  show('edit', p ? 'Edit plant' : 'New plant', true);
  if (!p) setTimeout(() => $('#f-name').focus(), 50);
}

/* ---------- settings ---------- */

function renderSettings() {
  const count = live().length;

  let server;
  if (lastError) {
    server = `Cannot reach ${new URL(API).host} — ${lastError}.` +
             (dirty ? ' Your changes will be sent when it is back.' : '');
  } else if (lastSync) {
    server = `Synced with ${new URL(API).host} at ${fmtTime(lastSync)}.`;
  } else {
    server = `Not synced yet this session.`;
  }

  $('#s-server').textContent = server;
  $('#s-count').textContent =
    `${count} plant${count === 1 ? '' : 's'} cached on this device` +
    (dirty ? ', with changes waiting to sync.' : '.');

  show('settings', 'Settings', true);
}

/* =========================================================================
   Wiring
   ========================================================================= */

window.addEventListener('hashchange', render);

$('#back').onclick = () => history.back();

$('#s-sync').onclick = () => sync();

$('#s-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 1, plants }, null, 2)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'plants-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('#s-import').onclick = () => $('#s-file').click();

$('#s-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.plants;
    if (!Array.isArray(incoming)) throw new Error('no plant list in that file');
    plants = merge(plants, incoming);
    commit();
    renderSettings();
    setStatus(`Imported. ${live().length} plants now.`, false);
  } catch (err) {
    setStatus('Import failed: ' + err.message, true, true);
  }
  e.target.value = '';
};

$('#s-forget').onclick = () => {
  if (!confirm('Erase the copy cached in this browser? The server keeps its copy, and the next sync pulls it back.')) return;
  plants = [];
  dirty = false;
  write(K_DIRTY, false);
  persist();
  renderSettings();
  setStatus('Local copy erased.', false);
  sync(true);
};

// Coming back to a phone that has been asleep: re-check the server.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sync(true);
});
window.addEventListener('online', () => sync(true));

render();
sync(true);
