'use strict';

/* =========================================================================
   Plants — a personal plant database.

   The page and its data both come from a small server on the home network
   (server.py). localStorage is only a cache: it lets the app show your plants
   — and accept edits — while the server is rebooting or the Wi-Fi drops. Those
   edits are marked dirty and pushed on the next successful sync.
   ========================================================================= */

const K_PLANTS = 'plantdb.plants.v1';
const K_SPECIES = 'plantdb.species.v1';
const K_DIRTY  = 'plantdb.dirty.v1';

const API = new URL('api/plants', document.baseURI).href;
const TIMEOUT = 8000;
const PHOTO_SIZE = 512;
const PHOTO_QUALITY = 0.82;

let plants = read(K_PLANTS, []);
let species = read(K_SPECIES, []);
let dirty  = read(K_DIRTY, false);   // local changes the server has not seen
let lastSync = null;
let lastError = '';
let cameFrom = '';                   // the route the current view was reached from

/* ---------- tiny helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

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
  write(K_SPECIES, species);
}

const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const live = () => plants.filter((p) => !p.deletedAt);

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/* plant.place is 'inside' or 'outside'; empty or absent means it was never set,
   which is what every plant added before this existed looks like. */
const PLACE = { inside: 'Inside', outside: 'Outside' };
const placeText = (plant) => PLACE[plant.place] || '';

/* =========================================================================
   Temperature and humidity

   plant.temps is { absMin, avgMin, avgMax, absMax }, in whole °C: the range
   the plant is happy in, and the wider one it merely survives. plant.humidity
   is { min, max }, in whole per cent.

   Every figure is optional. A key is present only once it has been filled in,
   and the group itself is null or absent until at least one of its figures
   has been — which is what every plant added before these existed looks like,
   so there is nothing to migrate.
   ========================================================================= */

const DEGREES = ' °C';
const PER_CENT = '%';

/** One stored figure, or null where it was never filled in. */
function figure(plant, group, key) {
  const bag = plant[group];
  const value = bag ? Number(bag[key]) : NaN;
  return isFinite(value) ? value : null;
}

const temp = (plant, key) => figure(plant, 'temps', key);
const humid = (plant, key) => figure(plant, 'humidity', key);

/** "18–27 °C", or a single bound where only one end was given. */
function rangeText(low, high, unit) {
  if (low !== null && high !== null) return low + '–' + high + unit;
  if (low !== null) return 'Above ' + low + unit;
  if (high !== null) return 'Below ' + high + unit;
  return '';
}

/** "18–27 °C · Survives 5 to 38 °C", with either half alone if that is all there is. */
function tempText(plant) {
  const happy = rangeText(temp(plant, 'avgMin'), temp(plant, 'avgMax'), DEGREES);
  const absMin = temp(plant, 'absMin');
  const absMax = temp(plant, 'absMax');

  let limits = '';
  if (absMin !== null && absMax !== null) limits = 'Survives ' + absMin + ' to ' + absMax + DEGREES;
  else if (absMin !== null) limits = 'Survives down to ' + absMin + DEGREES;
  else if (absMax !== null) limits = 'Survives up to ' + absMax + DEGREES;

  return [happy, limits].filter(Boolean).join(' · ');
}

const humidityText = (plant) =>
  rangeText(humid(plant, 'min'), humid(plant, 'max'), PER_CENT);

/* =========================================================================
   Species and inheritance

   A species record carries what is true of every plant of that kind — the
   temperatures, the humidity, and how often it wants water — and nothing that
   belongs to an individual: no watering notes, no notes, no photo, no diary
   of when it was last watered.

   A plant follows one through `speciesId`. Wherever the plant leaves a group
   unset the species' figure applies; anything the plant fills in wins. Since
   "unset" was already how these read, every plant that existed before species
   did inherits nothing and behaves exactly as it did.

   A `speciesId` naming a species this device has not synced yet, or one that
   has since been deleted, resolves to nothing and the plant falls back to its
   own figures. Across two phones that is a normal intermediate state rather
   than damage, which is why nothing enforces the reference.
   ========================================================================= */

let speciesById = new Map();

function indexSpecies() {
  speciesById = new Map();
  for (const record of species) {
    if (!record.deletedAt) speciesById.set(record.id, record);
  }
}

const liveSpecies = () => species.filter((s) => !s.deletedAt);

/** The species a plant follows, or null. */
const speciesOf = (plant) =>
  (plant && plant.speciesId && speciesById.get(plant.speciesId)) || null;

/** The species going by this name, or null. Matching ignores case and edges. */
function speciesByName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return liveSpecies().find((s) => String(s.name).trim().toLowerCase() === wanted) || null;
}

/**
 * Which figures are in force for a plant, and where they came from: the
 * plant's own if it has any, otherwise its species'. `from` is 'plant',
 * 'species', or '' when neither has anything to say.
 */
function inherited(plant, key) {
  if (plant[key]) return { value: plant[key], from: 'plant' };
  const parent = speciesOf(plant);
  if (parent && parent[key]) return { value: parent[key], from: 'species' };
  return { value: null, from: '' };
}

/** The day a plant was added, as a date key; today if it never recorded one. */
function addedKey(plant) {
  const added = new Date(plant.createdAt);
  return isNaN(added) ? todayKey() : keyOf(added);
}

/**
 * The schedule a plant actually runs on.
 *
 * A species supplies the shape — every 7 days, or Mondays and Fridays — but
 * never the anchor: when the clock started is a fact about your plant, not
 * about the kind of plant it is. An inherited interval therefore counts from
 * the last watering, falling back to the day the plant was added, so linking
 * an old plant to a weekly species puts it straight on today's list rather
 * than pretending it was watered just now.
 */
function effectiveSchedule(plant) {
  const found = inherited(plant, 'schedule');
  const shape = found.value;
  if (!shape || found.from === 'plant' || shape.type !== 'interval') return shape;
  return {
    type: 'interval',
    days: shape.days,
    start: plant.lastWatered || addedKey(plant)
  };
}

/* =========================================================================
   Calendar days

   Schedules are about *days*, not instants, so they use local "YYYY-MM-DD"
   keys throughout. Anything derived from a UTC timestamp would put the app a
   day out of step for part of the evening.
   ========================================================================= */

const pad2 = (n) => String(n).padStart(2, '0');

const keyOf = (date) =>
  date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());

const todayKey = () => keyOf(new Date());

function parseKey(key) {
  const parts = String(key).split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}

/** Whole days from `from` to `to`; rounding keeps this right across DST. */
const daysBetween = (from, to) =>
  Math.round((parseKey(to) - parseKey(from)) / 86400000);

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mondayFirst = (dow) => (dow + 6) % 7;

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function fmtDayKey(key) {
  const d = parseKey(key);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* =========================================================================
   Schedules

   plant.schedule is one of:
     null                                        no schedule
     { type: 'interval', days: 7, start: 'YYYY-MM-DD' }
     { type: 'weekly',   weekdays: [1, 5] }      0 = Sunday … 6 = Saturday

   plant.lastWatered ('YYYY-MM-DD') moves the interval clock forward and takes
   a plant off today's list once it has been watered.
   ========================================================================= */

function scheduleText(plant) {
  const s = effectiveSchedule(plant);
  if (!s) return '';

  if (s.type === 'interval') {
    const n = Number(s.days) || 0;
    if (n < 1) return '';
    return n === 1 ? 'Every day' : 'Every ' + n + ' days';
  }

  if (s.type === 'weekly') {
    const days = (s.weekdays || []).slice().sort((a, b) => mondayFirst(a) - mondayFirst(b));
    if (!days.length) return '';
    if (days.length === 7) return 'Every day';
    return days.map((d) => DAY_SHORT[d]).join(', ');
  }

  return '';
}

/** The next day this plant wants water, as a date key, or '' if unscheduled. */
function nextDueKey(plant, today) {
  const s = effectiveSchedule(plant);
  if (!s) return '';

  if (s.type === 'interval') {
    const n = Number(s.days) || 0;
    if (n < 1) return '';
    const anchor = plant.lastWatered || s.start || today;
    const next = addDays(anchor, n);
    // An anchor far in the past should read as "due", not as a date in 2019.
    return daysBetween(next, today) > 0 ? today : next;
  }

  if (s.type === 'weekly') {
    const days = s.weekdays || [];
    if (!days.length) return '';
    const from = plant.lastWatered === today ? addDays(today, 1) : today;
    for (let i = 0; i < 7; i++) {
      const key = addDays(from, i);
      if (days.indexOf(parseKey(key).getDay()) !== -1) return key;
    }
  }

  return '';
}

/**
 * How this plant stands today.
 *   { due, late }  late is the number of whole days an interval is overdue.
 */
function waterStatus(plant, today) {
  const s = effectiveSchedule(plant);
  if (!s) return { due: false, late: 0 };
  if (plant.lastWatered === today) return { due: false, late: 0, watered: true };

  if (s.type === 'interval') {
    const n = Number(s.days) || 0;
    if (n < 1) return { due: false, late: 0 };
    const anchor = plant.lastWatered || s.start;
    if (!anchor) return { due: false, late: 0 };
    const late = daysBetween(addDays(anchor, n), today);
    return { due: late >= 0, late: Math.max(0, late) };
  }

  if (s.type === 'weekly') {
    const days = s.weekdays || [];
    return { due: days.indexOf(parseKey(today).getDay()) !== -1, late: 0 };
  }

  return { due: false, late: 0 };
}

/** One line of plain English about where a plant stands. */
function statusText(plant, today) {
  if (!effectiveSchedule(plant)) return '';
  const status = waterStatus(plant, today);

  if (status.late > 0) return status.late === 1 ? '1 day late' : status.late + ' days late';
  if (status.due) return 'Due today';
  if (status.watered) return 'Watered today';

  const next = nextDueKey(plant, today);
  if (!next) return '';
  const away = daysBetween(today, next);
  if (away === 1) return 'Next tomorrow';
  return 'Next ' + fmtDayKey(next);
}

function dueToday(today) {
  return live()
    .filter((p) => waterStatus(p, today).due)
    .sort((a, b) => {
      const late = waterStatus(b, today).late - waterStatus(a, today).late;
      return late !== 0 ? late : byName(a, b);
    });
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

/** A server too old to know about species simply does not mention them. */
const remoteSpecies = (doc) => (Array.isArray(doc.species) ? doc.species : []);

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
      doc = await request('PUT', { plants: plants, species: species });
    } else {
      doc = await request('GET');
      // Nothing of ours is missing in the usual case; push only if it is.
      const mergedPlants = merge(plants, doc.plants);
      const mergedSpecies = merge(species, remoteSpecies(doc));
      if (signature(mergedPlants) !== signature(doc.plants) ||
          signature(mergedSpecies) !== signature(remoteSpecies(doc))) {
        doc = await request('PUT', { plants: mergedPlants, species: mergedSpecies });
      }
    }

    plants = doc.plants;
    species = remoteSpecies(doc);
    indexSpecies();
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
  indexSpecies();
  persist();
  dirty = true;
  write(K_DIRTY, true);
  refresh();
  sync(true);
}

/* =========================================================================
   Photos

   Resized to a 512x512 JPEG in the browser before upload: the Pi never has to
   decode a 4 MB phone photo, and nothing extra has to be installed on it. The
   file itself lives on the server, not in plants.json — a few dozen base64
   photos would blow past the ~5 MB localStorage quota and be re-sent on every
   sync. The plant record only carries `photo`, a version stamp used to bust
   the image cache when a photo is replaced.
   ========================================================================= */

const photoEndpoint = (id) =>
  new URL('api/photo/' + encodeURIComponent(id), document.baseURI).href;

const photoSrc = (plant) =>
  new URL('photos/' + encodeURIComponent(plant.id) + '.jpg?v=' +
          encodeURIComponent(plant.photo), document.baseURI).href;

/** Centre-cropped square JPEG, with EXIF rotation honoured. */
async function squareJpeg(file, size) {
  let bitmap = null;
  let objectUrl = '';
  let source;

  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      source = bitmap;
    } catch (e) {
      bitmap = null;    // older Safari, or a format it cannot decode this way
    }
  }

  if (!source) {
    objectUrl = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the browser cannot read that image'));
      img.src = objectUrl;
    });
  }

  try {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    if (!width || !height) throw new Error('the image has no size');

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    const side = Math.min(width, height);
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('could not encode a JPEG')),
        'image/jpeg', PHOTO_QUALITY);
    });
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function attachPhoto(id, file) {
  const plant = plants.find((x) => x.id === id && !x.deletedAt);
  if (!plant || !file) return;

  setStatus('Preparing photo…', false, true);

  let blob;
  try {
    blob = await squareJpeg(file, PHOTO_SIZE);
  } catch (e) {
    setStatus('Could not use that image: ' + e.message, true, true);
    return;
  }

  setStatus('Uploading photo…', false, true);
  try {
    const res = await fetch(photoEndpoint(id), {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch (err) { /* not JSON */ }
      throw new Error(detail || ('the server returned ' + res.status));
    }
  } catch (e) {
    // Photos go straight to the server — there is no offline queue for them.
    setStatus('Photo not saved (' + (e.message || 'no connection') +
              '). Photos need the server, so try again at home.', true, true);
    return;
  }

  plant.photo = new Date().toISOString();
  plant.updatedAt = plant.photo;
  commit();
  setStatus('Photo saved', false);
}

async function removePhoto(id) {
  const plant = plants.find((x) => x.id === id && !x.deletedAt);
  if (!plant) return;
  if (!confirm('Remove the photo of “' + plant.name + '”?')) return;

  try {
    await fetch(photoEndpoint(id), { method: 'DELETE', cache: 'no-store' });
  } catch (e) {
    // The record is what matters; a stray file on the Pi is harmless.
  }

  delete plant.photo;
  plant.updatedAt = new Date().toISOString();
  commit();
}

function markWatered(id) {
  const p = plants.find((x) => x.id === id && !x.deletedAt);
  if (!p) return;
  p.lastWatered = todayKey();
  p.updatedAt = new Date().toISOString();
  commit();
}

/* =========================================================================
   Routing — #/ , #/all , #/new , #/p/<id> , #/p/<id>/edit , #/settings
   ========================================================================= */

const VIEWS = ['list', 'all', 'detail', 'edit', 'species', 'species-edit', 'settings'];

function route() {
  return (location.hash || '#/').slice(1);
}

function show(view, title, canGoBack) {
  for (const name of VIEWS) {
    $('#view-' + name).hidden = name !== view;
  }
  $('#title').textContent = title;
  $('#back').hidden = !canGoBack;

  const path = route();
  for (const tab of $$('.tab')) {
    tab.classList.toggle('active', tab.getAttribute('data-tab') === path);
  }

  window.scrollTo(0, 0);
}

/**
 * Navigate, replacing the current history entry. Used after saving or deleting
 * so that Back never returns to a form that has already been submitted.
 */
function replaceRoute(hash) {
  location.replace(hash);
  render();     // the hashchange fires too; rendering twice is harmless
}

/** Re-render after a background change, without clobbering a half-typed form. */
function refresh() {
  const path = route();
  if (path === '/new' || path === '/s/new' || /\/edit$/.test(path)) return;
  render();
}

function render() {
  const path = route();

  if (path === '/settings') return renderSettings();
  if (path === '/all') return renderAll();
  if (path === '/new') return renderForm(null);
  if (path === '/species') return renderSpecies();
  if (path === '/s/new') return renderSpeciesForm(null);

  const speciesEdit = path.match(/^\/s\/([^/]+)\/edit$/);
  if (speciesEdit) return renderSpeciesForm(speciesEdit[1]);

  const editMatch = path.match(/^\/p\/([^/]+)\/edit$/);
  if (editMatch) return renderForm(editMatch[1]);

  const detailMatch = path.match(/^\/p\/([^/]+)$/);
  if (detailMatch) return renderDetail(detailMatch[1]);

  return renderToday();
}

/* ---------- lists ---------- */

/**
 * One row: a link to the plant, plus (on today's list) a button to tick it off
 * without opening it.
 */
function plantRow(plant, today, withTick) {
  const li = document.createElement('li');

  const a = document.createElement('a');
  a.href = '#/p/' + encodeURIComponent(plant.id);

  if (plant.photo) {
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = photoSrc(plant);
    thumb.alt = '';
    thumb.loading = 'lazy';
    a.appendChild(thumb);
  }

  const text = document.createElement('div');
  text.className = 'text';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = plant.name;
  text.appendChild(name);

  const status = waterStatus(plant, today);
  const rest = withTick ? statusText(plant, today)
                        : [scheduleText(plant), statusText(plant, today)]
                            .filter(Boolean).join(' · ') || plant.water || '';
  const detail = [placeText(plant), rest].filter(Boolean).join(' · ');
  if (detail) {
    const sub = document.createElement('div');
    sub.className = 'sub' + (status.late > 0 ? ' late' : '');
    sub.textContent = detail;
    text.appendChild(sub);
  }

  a.appendChild(text);
  li.appendChild(a);

  if (withTick) {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick';
    tick.textContent = '✓';
    tick.setAttribute('aria-label', 'Mark ' + plant.name + ' as watered');
    tick.onclick = () => markWatered(plant.id);
    li.appendChild(tick);
  }

  return li;
}

function renderToday() {
  const today = todayKey();
  const all = live();
  const due = dueToday(today);

  const ul = $('#today-list');
  ul.textContent = '';
  for (const p of due) ul.appendChild(plantRow(p, today, true));

  const hasPlants = all.length > 0;
  $('#no-plants').hidden = hasPlants;
  $('#today-heading').hidden = !hasPlants;
  $('#today-empty').hidden = !hasPlants || due.length > 0;

  show('list', due.length ? `Today (${due.length})` : 'Today', false);
}

function renderAll() {
  const today = todayKey();
  const items = live().sort(byName);

  const ul = $('#plant-list');
  ul.textContent = '';
  for (const p of items) ul.appendChild(plantRow(p, today, false));

  show('all', `All plants (${items.length})`, true);
}

/* ---------- detail ---------- */

function renderDetail(id) {
  const today = todayKey();
  const p = plants.find((x) => x.id === id && !x.deletedAt);
  if (!p) {
    location.replace('#/');   // no history entry for a plant that is gone
    return;
  }

  $('#d-name').textContent = p.name;

  const photo = $('#d-photo');
  photo.hidden = !p.photo;
  if (p.photo) {
    photo.src = photoSrc(p);
    photo.alt = p.name;
  } else {
    photo.removeAttribute('src');
  }

  const parent = speciesOf(p);
  const speciesLink = $('#d-species-from');
  fill($('#d-species'), parent ? parent.name : p.species, 'Not set');
  speciesLink.hidden = !parent;
  if (parent) {
    speciesLink.textContent = 'open';
    speciesLink.href = '#/s/' + encodeURIComponent(parent.id) + '/edit';
  }

  fill($('#d-place'), placeText(p), 'Not set');

  // Figures may be the plant's own or its species'; say which, so that a
  // number you did not type is never mistaken for one you did.
  const temps = inherited(p, 'temps');
  const humidity = inherited(p, 'humidity');
  fill($('#d-temp'), temps.value ? tempText({ temps: temps.value }) : '', 'Not set');
  fill($('#d-humidity'),
       humidity.value ? humidityText({ humidity: humidity.value }) : '', 'Not set');
  markInherited($('#d-temp-from'), temps.from);
  markInherited($('#d-humidity-from'), humidity.from);
  markInherited($('#d-sched-from'), inherited(p, 'schedule').from);

  const schedule = scheduleText(p);
  const status = statusText(p, today);
  fill($('#d-sched'), [schedule, status].filter(Boolean).join(' · '), 'No schedule set');
  $('#d-sched').classList.toggle('late', waterStatus(p, today).late > 0);

  fill($('#d-water'), p.water, 'No watering notes');
  fill($('#d-notes'), p.notes, 'No notes');

  const meta = [];
  if (p.createdAt) meta.push('Added ' + fmtDate(p.createdAt));
  if (p.lastWatered) {
    meta.push(p.lastWatered === today
      ? 'Watered today'
      : 'Last watered ' + fmtDayKey(p.lastWatered));
  }
  $('#d-meta').textContent = meta.join(' · ');

  const watered = $('#d-watered');
  watered.disabled = p.lastWatered === today;
  watered.textContent = watered.disabled ? 'Watered today ✓' : 'Mark as watered';
  watered.onclick = () => markWatered(p.id);

  const add = $('#d-photo-add');
  const remove = $('#d-photo-remove');
  const picker = $('#d-photo-file');
  add.textContent = p.photo ? 'Replace photo' : 'Add photo';
  add.onclick = () => picker.click();
  remove.hidden = !p.photo;
  remove.onclick = () => removePhoto(p.id);
  picker.onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';               // let the same file be picked again
    attachPhoto(p.id, file);
  };

  $('#d-edit').href = '#/p/' + encodeURIComponent(p.id) + '/edit';
  $('#d-delete').onclick = () => {
    if (!confirm(`Delete “${p.name}”?`)) return;
    if (p.photo) {
      fetch(photoEndpoint(p.id), { method: 'DELETE', cache: 'no-store' }).catch(() => {});
    }
    p.deletedAt = new Date().toISOString();
    p.updatedAt = p.deletedAt;
    commit();
    // Back must not return to the plant that was just deleted
    replaceRoute('#/');
  };

  show('detail', p.name, true);
}

/** Flags a detail field whose value came from the species, not the plant. */
function markInherited(node, from) {
  node.hidden = from !== 'species';
  node.textContent = from === 'species' ? 'inherited' : '';
}

function fill(node, text, placeholder) {
  node.textContent = text || placeholder;
  node.classList.toggle('blank', !text);
}

/* ---------- add / edit ---------- */

const placeRadios = () => $$('input[name="place"]');

function loadPlace(plant) {
  const value = (plant && plant.place) || 'none';
  for (const radio of placeRadios()) radio.checked = radio.value === value;
}

/** Reads the picker; '' for "not set", which is how an unset plant reads too. */
function readPlace() {
  const checked = placeRadios().filter((r) => r.checked)[0];
  return !checked || checked.value === 'none' ? '' : checked.value;
}

/* The two groups of optional figures, for whichever form is asking. `fields`
   is listed lowest to highest, which is the order the boxes have to read in,
   and `placeholders` lives here rather than in the markup so that a box can
   show the figure it would inherit instead. */
function figureGroups(prefix) {
  const at = (name) => '#' + prefix + '-' + name;
  return [
    {
      group: 'temps',
      fields: { absMin: at('abs-min'), avgMin: at('avg-min'),
                avgMax: at('avg-max'), absMax: at('abs-max') },
      placeholders: { absMin: '5', avgMin: '18', avgMax: '27', absMax: '38' },
      floor: -60,
      ceiling: 60,
      error: at('temp-error'),
      message: 'Those read out of order — they should rise from the coldest it survives to the hottest.'
    },
    {
      group: 'humidity',
      fields: { min: at('hum-min'), max: at('hum-max') },
      placeholders: { min: '40', max: '60' },
      floor: 0,
      ceiling: 100,
      error: at('hum-error'),
      message: 'The first figure cannot be higher than the second.'
    }
  ];
}

const GROUPS = figureGroups('f');            // the plant form
const SPECIES_GROUPS = figureGroups('sp');   // the species form

function loadFigures(spec, record, from) {
  for (const key of Object.keys(spec.fields)) {
    const box = $(spec.fields[key]);
    const value = record ? figure(record, spec.group, key) : null;
    box.value = value === null ? '' : value;
    box.classList.remove('invalid');
  }
  showInherited(spec, from);
  $(spec.error).hidden = true;
}

/**
 * Put whatever the plant would inherit into the empty boxes as their
 * placeholder, so that "left blank" visibly means "18 from the species"
 * rather than looking like nothing at all.
 */
function showInherited(spec, from) {
  for (const key of Object.keys(spec.fields)) {
    const value = from ? figure(from, spec.group, key) : null;
    $(spec.fields[key]).placeholder = value === null ? spec.placeholders[key] : String(value);
  }
}

/** Reads one group's boxes. Returns null when none of them were filled in. */
function readFigures(spec) {
  const out = {};
  let any = false;
  for (const key of Object.keys(spec.fields)) {
    const raw = $(spec.fields[key]).value.trim();
    if (!raw) continue;
    const value = Math.round(Number(raw));
    if (!isFinite(value)) continue;      // a browser that let something odd through
    out[key] = Math.min(spec.ceiling, Math.max(spec.floor, value));
    any = true;
  }
  return any ? out : null;
}

/**
 * The first box holding a figure lower than the one before it, or '' if they
 * all read low to high. Blanks are skipped, so filling in only the two
 * comfortable temperatures checks them against each other and nothing else.
 */
function firstOutOfOrder(spec, values) {
  if (!values) return '';
  const filled = Object.keys(spec.fields).filter((key) => key in values);
  for (let i = 1; i < filled.length; i++) {
    if (values[filled[i]] < values[filled[i - 1]]) return filled[i];
  }
  return '';
}

/** Shows or clears one group's complaint; returns the offending key, or ''. */
function markFigureProblem(spec, values) {
  const wrong = firstOutOfOrder(spec, values);
  for (const key of Object.keys(spec.fields)) {
    $(spec.fields[key]).classList.toggle('invalid', key === wrong);
  }
  $(spec.error).textContent = wrong ? spec.message : '';
  $(spec.error).hidden = !wrong;
  return wrong;
}

/* The schedule controls, for whichever form is asking. A species schedule is
   a shape only — `anchored` is what says whether a start date belongs on it. */
function scheduleControls(prefix, anchored) {
  const at = (name) => '#' + prefix + '-' + name;
  return {
    radios: 'input[name="' + (prefix === 'f' ? 'sched' : prefix + '-sched') + '"]',
    days: at('days'),
    weekBoxes: at('days-of-week') + ' input[type="checkbox"]',
    intervalPanel: prefix === 'f' ? '#sched-interval' : at('sched-interval'),
    weeklyPanel: prefix === 'f' ? '#sched-weekly' : at('sched-weekly'),
    anchored: anchored
  };
}

const PLANT_SCHED = scheduleControls('f', true);
const SPECIES_SCHED = scheduleControls('sp', false);

const schedRadios = (sched) => $$(sched.radios);
const dayBoxes = (sched) => $$(sched.weekBoxes);

function selectedSchedType(sched) {
  const checked = schedRadios(sched).filter((r) => r.checked)[0];
  return checked ? checked.value : 'none';
}

function showSchedPanels(sched) {
  const type = selectedSchedType(sched);
  $(sched.intervalPanel).hidden = type !== 'interval';
  $(sched.weeklyPanel).hidden = type !== 'weekly';
}

function loadSchedule(sched, record) {
  const s = (record && record.schedule) || null;
  const type = s ? s.type : 'none';

  for (const radio of schedRadios(sched)) radio.checked = radio.value === type;
  $(sched.days).value = (s && s.type === 'interval' && s.days) || 7;

  const selected = (s && s.type === 'weekly' && s.weekdays) || [];
  for (const box of dayBoxes(sched)) box.checked = selected.indexOf(Number(box.value)) !== -1;

  showSchedPanels(sched);
}

/** Reads the schedule controls. Returns null for "no schedule". */
function readSchedule(sched, previous) {
  const type = selectedSchedType(sched);

  if (type === 'interval') {
    let days = parseInt($(sched.days).value, 10);
    if (!isFinite(days) || days < 1) days = 1;
    if (days > 365) days = 365;
    if (!sched.anchored) return { type: 'interval', days: days };
    // Keep the original anchor when only the interval length changed.
    const start = (previous && previous.type === 'interval' && previous.start) || todayKey();
    return { type: 'interval', days: days, start: start };
  }

  if (type === 'weekly') {
    const weekdays = dayBoxes(sched).filter((b) => b.checked).map((b) => Number(b.value));
    if (!weekdays.length) return null;      // no days ticked means no schedule
    return { type: 'weekly', weekdays: weekdays.sort((a, b) => a - b) };
  }

  return null;
}

/**
 * Reflect whatever species the box currently names: what it is linked to, and
 * what the empty boxes below would inherit if left alone.
 */
function applySpeciesToForm() {
  const typed = $('#f-species').value.trim();
  const parent = speciesByName(typed);
  const hint = $('#f-species-hint');

  if (!typed) {
    hint.textContent = 'Optional. Naming a species shares its temperature, ' +
                       'humidity and watering schedule with every plant of that kind.';
  } else if (parent) {
    hint.textContent = 'Linked to ' + parent.name +
                       '. Anything left empty below follows it.';
  } else {
    hint.textContent = 'No species called that yet — add one under Species to ' +
                       'share figures between plants of this kind.';
  }

  for (const spec of GROUPS) showInherited(spec, parent);
  showSchedHint(parent);
  return parent;
}

/** Says what an unset schedule will fall back to, when there is one. */
function showSchedHint(parent) {
  const hint = $('#f-sched-hint');
  const shape = parent && parent.schedule;
  const ownSchedule = selectedSchedType(PLANT_SCHED) !== 'none';

  hint.hidden = !shape || ownSchedule;
  if (!hint.hidden) {
    hint.textContent = 'Left as None, this plant follows ' + parent.name + ': ' +
                       scheduleText({ schedule: shape }).toLowerCase() + '.';
  }
}

function renderForm(id) {
  const p = id ? plants.find((x) => x.id === id && !x.deletedAt) : null;
  if (id && !p) {
    location.replace('#/');
    return;
  }

  const form = $('#form');
  form.reset();
  $('#f-name').value = p ? p.name : '';
  $('#f-water').value = p ? p.water || '' : '';
  $('#f-notes').value = p ? p.notes || '' : '';
  $('#f-name').classList.remove('invalid');
  $('#f-species').value = p ? p.species || '' : '';
  loadPlace(p);
  for (const spec of GROUPS) loadFigures(spec, p);
  loadSchedule(PLANT_SCHED, p);
  applySpeciesToForm();

  form.onsubmit = (e) => {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    if (!name) {
      $('#f-name').classList.add('invalid');
      $('#f-name').focus();
      return;
    }

    // Every group is checked even once one has failed, so that a complaint
    // about a box that has since been fixed never survives on screen.
    const figures = {};
    let firstProblem = '';
    for (const spec of GROUPS) {
      figures[spec.group] = readFigures(spec);
      const wrong = markFigureProblem(spec, figures[spec.group]);
      if (wrong && !firstProblem) firstProblem = spec.fields[wrong];
    }
    if (firstProblem) {
      $(firstProblem).focus();
      return;
    }

    const now = new Date().toISOString();
    const speciesName = $('#f-species').value.trim();
    const parent = speciesByName(speciesName);
    const speciesId = parent ? parent.id : '';
    const temps = figures.temps;
    const humidity = figures.humidity;
    const water = $('#f-water').value.trim();
    const notes = $('#f-notes').value.trim();
    const place = readPlace();
    const schedule = readSchedule(PLANT_SCHED, p && p.schedule);

    let saved = p;
    if (p) {
      Object.assign(p, { name, species: speciesName, speciesId, place, temps,
                         humidity, water, notes, schedule, updatedAt: now });
    } else {
      saved = { id: uid(), name, species: speciesName, speciesId, place, temps,
                humidity, water, notes, schedule, createdAt: now, updatedAt: now };
      plants.push(saved);
    }

    commit();
    // A submitted form must not stay in history, or Back from the plant lands
    // straight back in the editor. If the editor was opened from this plant's
    // own page, pop it; otherwise replace the entry. Either way a new plant
    // ends up on its own page, which is where a photo can be added.
    if (p && cameFrom === '/p/' + p.id) {
      history.back();
    } else {
      replaceRoute('#/p/' + encodeURIComponent(saved.id));
    }
  };

  $('#f-cancel').onclick = () => history.back();

  show('edit', p ? 'Edit plant' : 'New plant', true);
  if (!p) setTimeout(() => $('#f-name').focus(), 50);
}

/* ---------- species ---------- */

/** The one-line summary of what a species says, for its row in the list. */
const speciesSummary = (record) =>
  [tempText(record), humidityText(record), scheduleText(record)].filter(Boolean).join(' · ');

const followerCount = (record) => live().filter((p) => p.speciesId === record.id).length;

function renderSpecies() {
  const items = liveSpecies().slice().sort(byName);

  const ul = $('#species-list');
  ul.textContent = '';

  for (const record of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#/s/' + encodeURIComponent(record.id) + '/edit';

    const text = document.createElement('div');
    text.className = 'text';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = record.name;
    text.appendChild(name);

    const used = followerCount(record);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [speciesSummary(record),
                       used === 1 ? '1 plant' : used + ' plants'].filter(Boolean).join(' · ');
    text.appendChild(sub);

    a.appendChild(text);
    li.appendChild(a);
    ul.appendChild(li);
  }

  $('#no-species').hidden = items.length > 0;
  show('species', items.length ? `Species (${items.length})` : 'Species', false);
}

function renderSpeciesForm(id) {
  const record = id ? species.find((x) => x.id === id && !x.deletedAt) : null;
  if (id && !record) {
    location.replace('#/species');   // no history entry for a species that is gone
    return;
  }

  const form = $('#sp-form');
  form.reset();
  $('#sp-name').value = record ? record.name : '';
  $('#sp-name').classList.remove('invalid');
  for (const spec of SPECIES_GROUPS) loadFigures(spec, record, null);
  loadSchedule(SPECIES_SCHED, record);

  const remove = $('#sp-delete');
  remove.hidden = !record;
  remove.onclick = () => {
    const used = followerCount(record);
    const consequence = used === 0 ? ''
      : (used === 1 ? ' One plant follows it' : ' ' + used + ' plants follow it') +
        ' and would fall back to its own figures.';
    if (!confirm('Delete the species “' + record.name + '”?' + consequence)) return;
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    commit();
    replaceRoute('#/species');
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    const name = $('#sp-name').value.trim();
    if (!name) {
      $('#sp-name').classList.add('invalid');
      $('#sp-name').focus();
      return;
    }

    // Plants find their species by name, so two species cannot share one.
    const clash = speciesByName(name);
    if (clash && (!record || clash.id !== record.id)) {
      $('#sp-name').classList.add('invalid');
      $('#sp-name').focus();
      setStatus('There is already a species called ' + clash.name + '.', true, true);
      return;
    }

    const figures = {};
    let firstProblem = '';
    for (const spec of SPECIES_GROUPS) {
      figures[spec.group] = readFigures(spec);
      const wrong = markFigureProblem(spec, figures[spec.group]);
      if (wrong && !firstProblem) firstProblem = spec.fields[wrong];
    }
    if (firstProblem) {
      $(firstProblem).focus();
      return;
    }

    const now = new Date().toISOString();
    const schedule = readSchedule(SPECIES_SCHED, null);
    const wasCalled = record ? record.name : '';

    let saved = record;
    if (record) {
      Object.assign(record, { name, temps: figures.temps, humidity: figures.humidity,
                              schedule, updatedAt: now });
    } else {
      saved = { id: uid(), name, temps: figures.temps, humidity: figures.humidity,
                schedule, createdAt: now, updatedAt: now };
      species.push(saved);
    }

    // A plant links by id but remembers the name it was typed with. Renaming a
    // species has to carry its plants along, or the next edit of one of them
    // would find nothing by that name and quietly unlink it.
    if (wasCalled && wasCalled !== name) {
      for (const plant of live()) {
        if (plant.speciesId === saved.id && plant.species !== name) {
          plant.species = name;
          plant.updatedAt = now;
        }
      }
    }

    commit();
    replaceRoute('#/species');
  };

  $('#sp-cancel').onclick = () => history.back();

  show('species-edit', record ? 'Edit species' : 'New species', true);
  if (!record) setTimeout(() => $('#sp-name').focus(), 50);
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
    server = 'Not synced yet this session.';
  }

  $('#s-server').textContent = server;
  const kinds = liveSpecies().length;
  $('#s-count').textContent =
    `${count} plant${count === 1 ? '' : 's'} and ${kinds} ` +
    `species cached on this device` +
    (dirty ? ', with changes waiting to sync.' : '.');

  show('settings', 'Settings', true);
}

/* =========================================================================
   Wiring
   ========================================================================= */

window.addEventListener('hashchange', (e) => {
  // Remember where we came from, so a saved edit can pop the editor off the
  // history stack rather than leaving a duplicate entry behind it.
  cameFrom = '';
  if (e && e.oldURL) {
    try {
      cameFrom = new URL(e.oldURL).hash.slice(1);
    } catch (err) { /* not a URL we can read */ }
  }
  render();
});

$('#back').onclick = () => history.back();

for (const radio of schedRadios(PLANT_SCHED)) {
  radio.onchange = () => {
    showSchedPanels(PLANT_SCHED);
    showSchedHint(speciesByName($('#f-species').value));
  };
}
for (const radio of schedRadios(SPECIES_SCHED)) {
  radio.onchange = () => showSchedPanels(SPECIES_SCHED);
}

$('#f-species').oninput = applySpeciesToForm;

$('#s-sync').onclick = () => sync();

$('#s-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 2, species, plants }, null, 2)],
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
    // A backup taken before species existed simply has none to bring back.
    if (parsed && Array.isArray(parsed.species)) species = merge(species, parsed.species);
    commit();
    renderSettings();
    setStatus(`Imported. ${live().length} plants now.`, false);
  } catch (err) {
    setStatus('Import failed: ' + err.message, true, true);
  }
  e.target.value = '';
};

$('#s-docs').onclick = async () => {
  const panel = $('#s-doc');
  const button = $('#s-docs');

  if (!panel.hidden) {
    panel.hidden = true;
    button.textContent = 'Show README';
    return;
  }

  if (!panel.textContent) {              // fetched once, then kept
    button.disabled = true;
    try {
      const res = await fetch(new URL('README.md', document.baseURI).href, { cache: 'no-cache' });
      if (!res.ok) throw new Error('the server returned ' + res.status);
      panel.textContent = await res.text();
    } catch (e) {
      setStatus('Could not load the README: ' + (e.message || 'no connection'), true, true);
      button.disabled = false;
      return;
    }
    button.disabled = false;
  }

  panel.hidden = false;
  button.textContent = 'Hide README';
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

// Coming back to a phone that has been asleep: re-check the server, and
// re-render in case the date rolled over while it was in your pocket.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  sync(true);
});
window.addEventListener('online', () => sync(true));

indexSpecies();
render();
sync(true);
