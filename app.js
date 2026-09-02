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
const K_SOWINGS = 'plantdb.sowings.v1';
const K_DIRTY  = 'plantdb.dirty.v1';

const API = new URL('api/plants', document.baseURI).href;
const TIMEOUT = 8000;
const PHOTO_SIZE = 512;
const PHOTO_QUALITY = 0.82;

let plants = read(K_PLANTS, []);
let species = read(K_SPECIES, []);
let sowings = read(K_SOWINGS, []);
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
  write(K_SOWINGS, sowings);
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
   Conditions

   Four groups, each of which a plant or a species may carry:

     temps     { absMin, avgMin, avgMax, absMax }  whole °C
     humidity  { min, max }                        whole per cent
     ph        { min, max }                        0–14, one decimal place
     light     { hours, kind }                     hours a day, direct/indirect

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

/* Soil acidity, { min, max }, on the usual 0–14 scale. Unlike the others this
   one is kept to a decimal place: the difference between pH 6 and pH 6.5 is
   the difference between happy and chlorotic. */
const phText = (plant) =>
  rangeText(figure(plant, 'ph', 'min'), figure(plant, 'ph', 'max'), '');

/* Light is { hours, kind }, either half optional: how long it wants, and
   whether that light should fall on it directly. */
const LIGHT = { direct: 'direct', indirect: 'indirect' };

function lightText(plant) {
  const hours = figure(plant, 'light', 'hours');
  const kind = (plant.light && LIGHT[plant.light.kind]) || '';
  const spell = hours === null ? '' : (hours === 1 ? '1 hour' : hours + ' hours');

  if (spell && kind) return spell + ' of ' + kind + ' light';
  if (spell) return spell + ' of light';
  if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1) + ' light';
  return '';
}

/* Height is a fifth group of the same shape, carried by a species and by a
   catalogue entry but never by a plant: how big the kind gets is a fact about
   the kind, and the one place worth asking is an encyclopedia.

   Centimetres in the record, metres once that stops being readable. A single
   figure is what the article gave — "growing to 2 m tall" is stored as a
   minimum with no maximum — so it reads as a ceiling rather than as the
   bottom of a range it never had. */
function heightText(record) {
  const low = figure(record, 'height', 'min');
  const high = figure(record, 'height', 'max');
  const tall = high === null ? low : high;
  if (tall === null) return '';

  const unit = tall >= 100 ? ' m' : ' cm';
  const say = (cm) => (tall >= 100 ? Number((cm / 100).toFixed(1)) : cm);

  if (low === null || high === null) return 'To ' + say(tall) + unit;
  return say(low) + '–' + say(high) + unit;
}

/* =========================================================================
   Species and inheritance

   A species record carries what is true of every plant of that kind — the
   condition groups above, how big it gets, how often it wants water, and
   whatever the catalogue had to say about the kind — and nothing that belongs
   to an individual: no watering notes, no photo, no diary of when it was last
   watered. Notes sit on both, because they are two different notes: the
   species holds what is true of the kind, a plant what is true of yours.

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

/** A server too old to know about a list simply does not mention it. */
const remoteList = (doc, key) => (Array.isArray(doc[key]) ? doc[key] : []);

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
      doc = await request('PUT', { plants: plants, species: species, sowings: sowings });
    } else {
      doc = await request('GET');
      // Nothing of ours is missing in the usual case; push only if it is.
      const mergedPlants = merge(plants, doc.plants);
      const mergedSpecies = merge(species, remoteList(doc, 'species'));
      const mergedSowings = merge(sowings, remoteList(doc, 'sowings'));
      if (signature(mergedPlants) !== signature(doc.plants) ||
          signature(mergedSpecies) !== signature(remoteList(doc, 'species')) ||
          signature(mergedSowings) !== signature(remoteList(doc, 'sowings'))) {
        doc = await request('PUT', { plants: mergedPlants, species: mergedSpecies,
                                     sowings: mergedSowings });
      }
    }

    plants = doc.plants;
    species = remoteList(doc, 'species');
    sowings = remoteList(doc, 'sowings');
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
   Routing — #/ , #/all , #/new , #/p/<id> , #/p/<id>/edit ,
             #/species , #/s/new , #/s/<id> , #/s/<id>/edit ,
             #/s/from/<pageId> ,
             #/seeds , #/seed/new , #/seed/<id> , #/seed/<id>/edit ,
             #/catalog , #/c/<pageId> , #/settings
   ========================================================================= */

const VIEWS = ['list', 'all', 'detail', 'edit', 'species', 'species-detail',
               'species-edit', 'seeds', 'seed-detail', 'seed-edit',
               'catalog', 'catalog-detail', 'settings'];

function route() {
  return (location.hash || '#/').slice(1);
}

/**
 * Draw one view, and work out from the route whether it needs a way back.
 *
 * A page the bar at the bottom goes straight to has nothing to go back to —
 * the bar is already the way out, and an arrow that unwinds a trail you did
 * not know you were leaving only invites the question of where it goes. So
 * the back button appears on exactly the pages the bar cannot reach: a plant,
 * a species, a sowing, the catalogue, and the forms that edit them. That is
 * the same question as which tab is lit, and is answered in the same loop.
 */
function show(view, title) {
  for (const name of VIEWS) {
    $('#view-' + name).hidden = name !== view;
  }
  $('#title').textContent = title;

  const path = route();
  let onTab = false;
  for (const tab of $$('.tab')) {
    const active = tab.getAttribute('data-tab') === path;
    tab.classList.toggle('active', active);
    onTab = onTab || active;
  }
  $('#back').hidden = onTab;

  $('main').scrollTop = 0;
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
  if (path === '/new' || path === '/s/new' || path === '/seed/new') return;
  if (/\/edit$/.test(path)) return;
  if (/^\/s\/from\/\d+$/.test(path)) return;   // a form half filled from the catalogue
  // The catalogue is not made of plants. Nothing a sync brings back can change
  // what is on screen there, and re-rendering it would re-run the search over
  // the network: a second round trip for the same answer, landing under
  // whatever was being read at the time.
  if (path === '/catalog' || /^\/c\/\d+$/.test(path)) return;
  render();
}

function render() {
  const path = route();

  if (path === '/settings') return renderSettings();
  if (path === '/all') return renderAll();
  if (path === '/new') return renderForm(null);
  if (path === '/species') return renderSpecies();
  if (path === '/s/new') return renderSpeciesForm(null);
  if (path === '/seeds') return renderSeeds();
  if (path === '/seed/new') return renderSeedForm(null);
  if (path === '/catalog') return renderCatalog();

  const entryMatch = path.match(/^\/c\/(\d+)$/);
  if (entryMatch) return renderCatalogEntry(entryMatch[1]);

  const filled = path.match(/^\/s\/from\/(\d+)$/);
  if (filled) return renderSpeciesFromCatalog(filled[1]);

  const seedEdit = path.match(/^\/seed\/([^/]+)\/edit$/);
  if (seedEdit) return renderSeedForm(seedEdit[1]);

  const seedDetail = path.match(/^\/seed\/([^/]+)$/);
  if (seedDetail) return renderSeedDetail(seedDetail[1]);

  const speciesEdit = path.match(/^\/s\/([^/]+)\/edit$/);
  if (speciesEdit) return renderSpeciesForm(speciesEdit[1]);

  const speciesDetail = path.match(/^\/s\/([^/]+)$/);
  if (speciesDetail) return renderSpeciesDetail(speciesDetail[1]);

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
  const seeds = seedsDue(today);

  const ul = $('#today-list');
  ul.textContent = '';
  for (const p of due) ul.appendChild(plantRow(p, today, true));

  // Seeds whose germination window has arrived: a separate group, because
  // "go and look whether anything is through" is a different errand from
  // watering, and there is nothing to tick off without looking first.
  const seedList = $('#today-seeds');
  seedList.textContent = '';
  for (const sowing of seeds) seedList.appendChild(sowingRow(sowing, today));

  const hasPlants = all.length > 0;
  const hasSown = liveSowings().length > 0;

  $('#today-heading').hidden = !hasPlants;
  $('#today-empty').hidden = !hasPlants || due.length > 0;
  $('#today-seeds-heading').hidden = !hasSown;
  $('#today-seeds-empty').hidden = !hasSown || seeds.length > 0;

  // Nothing sown and nothing growing is the only genuinely empty day.
  $('#no-plants').hidden = hasPlants || hasSown;

  const total = due.length + seeds.length;
  show('list', total ? `Today (${total})` : 'Today');
}

function renderAll() {
  const today = todayKey();
  const items = live().sort(byName);

  const ul = $('#plant-list');
  ul.textContent = '';
  for (const p of items) ul.appendChild(plantRow(p, today, false));

  show('all', `All plants (${items.length})`);
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
    speciesLink.href = '#/s/' + encodeURIComponent(parent.id);
  }

  fill($('#d-place'), placeText(p), 'Not set');

  // Figures may be the plant's own or its species'; say which, so that a
  // number you did not type is never mistaken for one you did.
  showResolved(p, 'temps', '#d-temp', tempText);
  showResolved(p, 'humidity', '#d-humidity', humidityText);
  showResolved(p, 'ph', '#d-ph', phText);
  showResolved(p, 'light', '#d-light', lightText);
  // Only ever the species': a plant has no height of its own to record, and
  // the row simply reads "Not set" until the kind it follows knows one.
  showResolved(p, 'height', '#d-height', heightText);
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

  show('detail', p.name);
}

/**
 * Write one resolved group into its row on the detail page, flagged with
 * where it came from. `format` is handed an object carrying just that group,
 * so it reads the species' figures rather than the plant's empty ones.
 */
function showResolved(plant, key, selector, format) {
  const found = inherited(plant, key);
  const holder = {};
  holder[key] = found.value;

  fill($(selector), found.value ? format(holder) : '', 'Not set');
  markInherited($(selector + '-from'), found.from);
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
    },
    {
      group: 'ph',
      fields: { min: at('ph-min'), max: at('ph-max') },
      placeholders: { min: '6', max: '7' },
      floor: 0,
      ceiling: 14,
      decimals: 1,
      error: at('ph-error'),
      message: 'The first figure cannot be higher than the second.'
    }
  ];
}

/* The fifth group, appended for the species form alone. A plant has no height
   boxes to fill in, so `GROUPS` — which is also what the plant detail reads
   its inherited figures through — is left exactly as it was. */
const heightGroup = (prefix) => ({
  group: 'height',
  fields: { min: '#' + prefix + '-height-min', max: '#' + prefix + '-height-max' },
  placeholders: { min: '30', max: '90' },
  floor: 0,
  ceiling: 20000,          // 200 m, over the 116 of the tallest thing in the catalogue
  error: '#' + prefix + '-height-error',
  message: 'The first figure cannot be higher than the second.'
});

const GROUPS = figureGroups('f');            // the plant form
const SPECIES_GROUPS = figureGroups('sp').concat(heightGroup('sp'));

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
 *
 * The `inheriting` class separates the two kinds of grey figure a box can
 * show: a plain example of what belongs there, and a real figure that will
 * apply if the box is left alone. They are worth telling apart — the second
 * is data, the first is only a hint.
 */
function showInherited(spec, from) {
  for (const key of Object.keys(spec.fields)) {
    const value = from ? figure(from, spec.group, key) : null;
    const box = $(spec.fields[key]);
    box.placeholder = value === null ? spec.placeholders[key] : String(value);
    box.classList.toggle('inheriting', value !== null);
  }
}

/** Whole numbers everywhere except pH, which is kept to one decimal place. */
function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

/**
 * Read a typed number, accepting a comma for the decimal point.
 *
 * Most of Europe puts a comma there, and that is the key iOS offers on its
 * decimal keypad. An `<input type="number">` only understands a full stop, and
 * when it cannot parse what is in it, it hands back an empty string rather
 * than the text — so a pH typed as "6,5" vanished silently. The pH boxes are
 * therefore plain text and the parsing happens here.
 */
const decimal = (raw) => Number(String(raw).replace(/,/g, '.'));

/** Reads one group's boxes. Returns null when none of them were filled in. */
function readFigures(spec) {
  const out = {};
  let any = false;
  for (const key of Object.keys(spec.fields)) {
    const raw = $(spec.fields[key]).value.trim();
    if (!raw) continue;
    const value = roundTo(decimal(raw), spec.decimals);
    if (!isFinite(value)) continue;      // reported by markFigureProblem instead
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

const NOT_A_NUMBER = 'That does not read as a number.';

/**
 * A box holding something no amount of goodwill turns into a number, or ''.
 * Only the pH boxes can reach this: the rest are `type="number"`, which will
 * not let anything else be typed in the first place.
 */
function firstUnreadable(spec) {
  for (const key of Object.keys(spec.fields)) {
    const raw = $(spec.fields[key]).value.trim();
    // The emptiness check is belt and braces today, since Number('') is 0
    // rather than NaN, but it is what stops an empty box being called a bad
    // one the moment anybody reaches for parseFloat instead.
    if (raw && !isFinite(decimal(raw))) return key;
  }
  return '';
}

/** Shows or clears one group's complaint; returns the offending key, or ''. */
function markFigureProblem(spec, values) {
  const unreadable = firstUnreadable(spec);
  const wrong = unreadable || firstOutOfOrder(spec, values);

  for (const key of Object.keys(spec.fields)) {
    $(spec.fields[key]).classList.toggle('invalid', key === wrong);
  }
  $(spec.error).textContent = !wrong ? '' : (unreadable ? NOT_A_NUMBER : spec.message);
  $(spec.error).hidden = !wrong;
  return wrong;
}

/* Light is a number and a choice rather than a range, so it gets its own pair
   of readers instead of joining the figure groups above. */
function lightControls(prefix) {
  return {
    hours: '#' + prefix + '-light-hours',
    radios: 'input[name="' + (prefix === 'f' ? 'light' : prefix + '-light') + '"]'
  };
}

const PLANT_LIGHT = lightControls('f');
const SPECIES_LIGHT = lightControls('sp');

function loadLight(spec, record, from) {
  const hours = record ? figure(record, 'light', 'hours') : null;
  $(spec.hours).value = hours === null ? '' : hours;

  const kind = (record && record.light && record.light.kind) || 'none';
  for (const radio of $$(spec.radios)) radio.checked = radio.value === kind;

  showInheritedLight(spec, from);
}

/** The hours box borrows its species' figure as a placeholder, as ranges do. */
function showInheritedLight(spec, from) {
  const hours = from ? figure(from, 'light', 'hours') : null;
  const box = $(spec.hours);
  box.placeholder = hours === null ? '6' : String(hours);
  box.classList.toggle('inheriting', hours !== null);
}

/** Reads the light controls. Returns null when neither half was filled in. */
function readLight(spec) {
  const out = {};

  const raw = $(spec.hours).value.trim();
  if (raw) {
    const hours = Math.round(decimal(raw));
    if (isFinite(hours)) out.hours = Math.min(24, Math.max(0, hours));
  }

  const checked = $$(spec.radios).filter((r) => r.checked)[0];
  if (checked && checked.value !== 'none') out.kind = checked.value;

  return 'hours' in out || 'kind' in out ? out : null;
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
    hint.textContent = 'Optional. Naming a species shares its conditions and ' +
                       'watering schedule with every plant of that kind.';
  } else if (parent) {
    hint.textContent = 'Linked to ' + parent.name +
                       '. Anything left empty below follows it.';
  } else {
    hint.textContent = 'No species called that yet — add one under Species to ' +
                       'share figures between plants of this kind.';
  }

  for (const spec of GROUPS) showInherited(spec, parent);
  showInheritedLight(PLANT_LIGHT, parent);
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
  loadLight(PLANT_LIGHT, p);
  loadSchedule(PLANT_SCHED, p);
  applySpeciesToForm();      // fills in what the species would supply

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
    const ph = figures.ph;
    const light = readLight(PLANT_LIGHT);
    const water = $('#f-water').value.trim();
    const notes = $('#f-notes').value.trim();
    const place = readPlace();
    const schedule = readSchedule(PLANT_SCHED, p && p.schedule);

    let saved = p;
    if (p) {
      Object.assign(p, { name, species: speciesName, speciesId, place, temps,
                         humidity, ph, light, water, notes, schedule, updatedAt: now });
    } else {
      saved = { id: uid(), name, species: speciesName, speciesId, place, temps,
                humidity, ph, light, water, notes, schedule,
                createdAt: now, updatedAt: now };
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

  show('edit', p ? 'Edit plant' : 'New plant');
  if (!p) setTimeout(() => $('#f-name').focus(), 50);
}

/* ---------- species ---------- */

/** The one-line summary of what a species says, for its row in the list. */
const speciesSummary = (record) => {
  const ph = phText(record);
  return [heightText(record), tempText(record), humidityText(record),
          ph && 'pH ' + ph, lightText(record),
          scheduleText(record)].filter(Boolean).join(' · ');
};

const followerCount = (record) => live().filter((p) => p.speciesId === record.id).length;

function renderSpecies() {
  const items = liveSpecies().slice().sort(byName);

  const ul = $('#species-list');
  ul.textContent = '';

  for (const record of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#/s/' + encodeURIComponent(record.id);

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
  show('species', items.length ? `Species (${items.length})` : 'Species');
}

/**
 * One species, read rather than edited.
 *
 * A plant opens the species it follows, and the species list opens a row, so
 * this is what both land on: the same facts a catalogue entry shows, laid out
 * the same way, plus the plants of your own that follow it. The form is one
 * button away rather than the page itself — a species is read far more often
 * than it is changed.
 */
function renderSpeciesDetail(id) {
  const record = species.find((x) => x.id === id && !x.deletedAt);
  if (!record) {
    location.replace('#/species');   // no history entry for a species that is gone
    return;
  }

  $('#sd-name').textContent = record.name;

  fill($('#sd-temp'), tempText(record), 'Not set');
  fill($('#sd-humidity'), humidityText(record), 'Not set');
  const ph = phText(record);
  fill($('#sd-ph'), ph && 'pH ' + ph, 'Not set');
  fill($('#sd-light'), lightText(record), 'Not set');
  fill($('#sd-height'), heightText(record), 'Not set');
  fill($('#sd-sched'), scheduleText(record), 'No schedule set');

  // What the article committed to, on a species that was filled in from one.
  const box = $('#sd-catalog');
  box.hidden = !record.catalogId;
  if (!box.hidden) {
    const marks = fillMarks($('#sd-flags'), record);
    $('#sd-flags').hidden = !marks.length;
    // As on the catalogue entry: "Nothing recorded" under a mark or two would
    // be a contradiction, so the paragraph only stands in for absent marks.
    const uses = $('#sd-uses');
    uses.hidden = !record.uses && marks.length > 0;
    fill(uses, record.uses, 'Nothing recorded');
  }

  fill($('#sd-notes'), record.notes, 'No notes');

  // How its seeds have done, pooled across every sowing of it.
  const seedTotal = sumTallies(seedsOfSpecies(record));
  const seedBox = $('#sd-seed');
  seedBox.hidden = seedTotal.sown < 1;
  if (!seedBox.hidden) {
    renderBar($('#sd-seed-bar'), seedTotal);
    fillSplit($('#sd-seed-text'), seedTotal);
  }

  const today = todayKey();
  const mine = live().filter((p) => p.speciesId === record.id).sort(byName);
  const ul = $('#sd-plants');
  ul.textContent = '';
  for (const plant of mine) ul.appendChild(plantRow(plant, today, false));
  $('#sd-plants-heading').hidden = !mine.length;
  $('#sd-count').hidden = mine.length > 0;
  $('#sd-count').textContent = mine.length ? '' : 'No plants of this kind yet.';

  $('#sd-edit').href = '#/s/' + encodeURIComponent(record.id) + '/edit';
  const open = $('#sd-catalog-open');
  open.hidden = !record.catalogId;
  if (record.catalogId) open.href = '#/c/' + encodeURIComponent(record.catalogId);

  show('species-detail', 'Species');
}

/**
 * The species form. `entry` is a catalogue entry to fill it from, if this was
 * reached from one; the record it edits may be an existing species or none.
 */
function renderSpeciesForm(id, entry) {
  const record = id ? species.find((x) => x.id === id && !x.deletedAt) : null;
  if (id && !record) {
    location.replace('#/species');   // no history entry for a species that is gone
    return;
  }

  const form = $('#sp-form');
  form.reset();
  $('#sp-name').value = record ? record.name : '';
  $('#sp-name').classList.remove('invalid');
  $('#sp-notes').value = record ? record.notes || '' : '';
  for (const spec of SPECIES_GROUPS) loadFigures(spec, record, null);
  loadLight(SPECIES_LIGHT, record, null);
  loadSchedule(SPECIES_SCHED, record);

  // What the catalogue said, kept out of the form because none of it is
  // anything you would type. Saved back untouched unless an entry is pulled
  // in, which replaces it whole.
  let linked = catalogSnapshot(record);
  if (entry) linked = pullCatalogEntry(entry);
  showCatalogLink(linked);

  $('#sp-catalog-refresh').onclick = async () => {
    const button = $('#sp-catalog-refresh');
    button.disabled = true;
    try {
      linked = pullCatalogEntry(await catalogRequest('/' + encodeURIComponent(linked.catalogId)));
      showCatalogLink(linked);
      setStatus('Filled in from the catalogue. Nothing is saved until you press Save.');
    } catch (e) {
      setStatus('Cannot read the catalogue — ' + e.message + '.', true, true);
    } finally {
      button.disabled = false;
    }
  };

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
    const fields = { name, temps: figures.temps, humidity: figures.humidity,
                     ph: figures.ph, height: figures.height,
                     light: readLight(SPECIES_LIGHT),
                     schedule: readSchedule(SPECIES_SCHED, null),
                     notes: $('#sp-notes').value.trim(), updatedAt: now };
    // Undefined where the link was dropped or a mark went away, which is how
    // JSON.stringify is asked to leave a key out.
    for (const key of CATALOG_KEEP) fields[key] = linked[key];
    const wasCalled = record ? record.name : '';

    let saved = record;
    if (record) {
      Object.assign(record, fields);
    } else {
      saved = Object.assign({ id: uid(), createdAt: now }, fields);
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
    // Same as the plant form: a submitted form must not stay in history. If
    // the editor was opened from this species' own page, pop it; otherwise
    // replace the entry. Either way it ends up on the species it just saved.
    if (record && cameFrom === '/s/' + record.id) {
      history.back();
    } else {
      replaceRoute('#/s/' + encodeURIComponent(saved.id));
    }
  };

  $('#sp-cancel').onclick = () => history.back();

  show('species-edit', record ? 'Edit species' : 'New species');
  // Not when the catalogue has just filled the name in: there is nothing to
  // type, and on a phone the keyboard would cover what it filled in.
  if (!record && !entry) setTimeout(() => $('#sp-name').focus(), 50);
}

/* ---------- filling a species from the catalogue ----------

   The catalogue is 5,065 species that somebody has already looked up, and a
   species you type out by hand is one of them nine times in ten. Filling one
   in from the other copies the figures across rather than pointing at them:
   a phone holds your plants offline and would otherwise have nothing to show
   for a species the moment it is away from the Pi. What it keeps of the entry
   is `catalogId`, so the entry can be reopened and re-read later.
   ========================================================================= */

/* Wikipedia describes light four ways and a species knows two, so importing
   one of the other two has to choose. Partial sun is still sun; shade is the
   absence of it, which is what indirect light amounts to indoors. */
const CATALOG_TO_LIGHT = { direct: 'direct', indirect: 'indirect',
                           partial: 'direct', shade: 'indirect' };

/* What a species remembers of the entry it was filled from. Everything else
   the catalogue sends lands in a box on the form and is yours to edit; these
   have none, because they are not figures you would ever type — they are what
   the article committed to, and they are only worth having as read back. */
const CATALOG_KEEP = ['catalogId', 'uses', 'edible', 'otherUses', 'aquatic'];

const catalogSnapshot = (record) => {
  const out = {};
  for (const key of CATALOG_KEEP) {
    if (record && record[key]) out[key] = record[key];
  }
  return out;
};

/** The species already filled from this entry, or the one going by its name. */
const speciesForEntry = (entry) =>
  liveSpecies().find((s) => s.catalogId === entry.pageId) ||
  speciesByName(entry.title) || null;

/**
 * Lay a catalogue entry over the species form, and return what of it has to
 * be carried into the record by hand.
 *
 * Every figure the entry records goes into its box over whatever was there:
 * that is what filling in from the catalogue has to mean, and since nothing
 * is written until Save, a fill you did not want is one Cancel away. The name
 * and the notes are filled only when empty — those are yours once you have
 * written them — and the schedule is never touched at all, because how often
 * you water something is not a fact an encyclopedia has an opinion on.
 */
function pullCatalogEntry(entry) {
  const name = $('#sp-name');
  if (!name.value.trim()) name.value = entry.title;
  name.classList.remove('invalid');

  for (const spec of SPECIES_GROUPS) {
    for (const key of Object.keys(spec.fields)) {
      const value = figure(entry, spec.group, key);
      if (value !== null) $(spec.fields[key]).value = value;
      $(spec.fields[key]).classList.remove('invalid');
    }
    $(spec.error).hidden = true;
  }

  const hours = figure(entry, 'light', 'hours');
  if (hours !== null) $(SPECIES_LIGHT.hours).value = hours;
  const kind = CATALOG_TO_LIGHT[(entry.light && entry.light.kind) || ''];
  if (kind) {
    for (const radio of $$(SPECIES_LIGHT.radios)) radio.checked = radio.value === kind;
  }

  const notes = $('#sp-notes');
  if (!notes.value.trim()) notes.value = entry.notes || '';

  const kept = { catalogId: entry.pageId };
  if (entry.uses) kept.uses = entry.uses;
  for (const flag of ['edible', 'otherUses', 'aquatic']) {
    if (entry[flag]) kept[flag] = true;
  }
  return kept;
}

/** The "from the catalogue" block on the form: hidden until there is a link. */
function showCatalogLink(linked) {
  const box = $('#sp-catalog');
  box.hidden = !linked.catalogId;
  if (box.hidden) return;

  $('#sp-catalog-open').href = '#/c/' + encodeURIComponent(linked.catalogId);
  const marks = fillMarks($('#sp-catalog-flags'), linked);
  $('#sp-catalog-flags').hidden = !marks.length;
  fill($('#sp-catalog-uses'), linked.uses, 'Nothing recorded');
}

/**
 * The species form, opened from a catalogue entry.
 *
 * Which species it fills: the one already linked to this entry, else one
 * going by the entry's own name — that is the case this is really for, a
 * species typed out by hand before you thought to look it up — else a new
 * one. The entry has to be read before any of that can be decided, so a
 * catalogue that cannot be reached leaves you on the entry you came from
 * rather than on a blank form.
 */
async function renderSpeciesFromCatalog(pageId) {
  const mine = ++catalogRun;
  let entry;
  try {
    entry = await catalogRequest('/' + encodeURIComponent(pageId));
  } catch (e) {
    if (mine !== catalogRun) return;
    setStatus('Cannot read the catalogue — ' + e.message + '.', true, true);
    replaceRoute('#/c/' + encodeURIComponent(pageId));
    return;
  }
  if (mine !== catalogRun) return;

  const existing = speciesForEntry(entry);
  renderSpeciesForm(existing ? existing.id : null, entry);
}

/* =========================================================================
   The reference catalogue

   5,065 species sitting in a SQLite file on the Pi: mined from the English
   Wikipedia dump, and 1,132 of them filled out from pfaf.org, which states
   soil, shade and hardiness outright where an encyclopedia had to be read for
   them. It is searched there rather than held here: an encyclopedia has no
   business in localStorage, and unlike your own plants this is reference data
   you never edit, so there is nothing to sync and nothing to lose by needing
   the Pi to read it.

   Entries come back shaped exactly like a plant or a species — same four
   condition groups, same field names — so the formatting below is the code
   that already draws your own records.
   ========================================================================= */

const CATALOG = new URL('api/catalog', document.baseURI).href;
const CATALOG_WAIT = 250;        // ms of quiet before a typed name is searched

/* Wikipedia describes light four ways where the app's own records know two,
   so the catalogue does its own phrasing rather than bending LIGHT to fit. */
const CATALOG_LIGHT = { direct: 'Direct sun', indirect: 'Indirect light',
                        partial: 'Partial sun', shade: 'Shade' };

/* Marks rather than figures: a set flag means the article commits to it, and
   an unset one means nobody wrote it down. Keyed by the field the server
   sends, so this list is also what the three tick boxes are wired from. */
const CATALOG_MARKS = { edible: 'Edible', otherUses: 'Other uses',
                        aquatic: 'Aquatic' };

const catalogMarks = (entry) =>
  Object.keys(CATALOG_MARKS).filter((name) => entry[name]).map((n) => CATALOG_MARKS[n]);

/** Draws an entry's marks into `node`, replacing whatever was there. */
function fillMarks(node, entry) {
  const marks = catalogMarks(entry);
  node.textContent = '';
  for (const label of marks) {
    const pill = document.createElement('span');
    pill.className = 'flag';
    pill.textContent = label;
    node.appendChild(pill);
  }
  return marks;
}

/* Which sources an entry was built from. Every row starts as a Wikipedia
   article, so plain `enwiki` says nothing worth a line — it is the absence of
   the other one, and the page already says Wikipedia twice. Empty on the
   Wikipedia-only build of the catalogue, which records no provenance at all. */
const CATALOG_SOURCE = { 'enwiki+pfaf': 'filled out from pfaf.org',
                         pfaf: 'from pfaf.org, no Wikipedia article' };

/* pfaf.org's three 0-5 ratings, in the order it prints them. Unlike the marks
   these have a real zero — somebody looked and found no use of that kind —
   so a 0 is shown rather than dropped, and the whole line is absent only
   where the plant was never rated. */
const CATALOG_RATINGS = { edible: 'edible', medicinal: 'medicinal',
                          other: 'other uses' };

/**
 * Draws the ratings line into `node`. Returns whether there was one.
 *
 * Written out as "4/5" rather than as stars: the marks above are already
 * pills, a second row of ornaments would compete with them, and the figure is
 * the thing worth reading — pfaf's own pages print the number too.
 */
function fillRatings(node, entry) {
  const ratings = entry.ratings || {};
  const said = Object.keys(CATALOG_RATINGS)
    .filter((name) => typeof ratings[name] === 'number')
    .map((name) => ratings[name] + '/5 ' + CATALOG_RATINGS[name]);

  node.textContent = said.length ? 'pfaf.org rates it ' + said.join(' · ') : '';
  node.hidden = !said.length;
  return said.length > 0;
}

function catalogLightText(entry) {
  const kind = (entry.light && CATALOG_LIGHT[entry.light.kind]) || '';
  const hours = figure(entry, 'light', 'hours');
  const spell = hours === null ? '' : (hours === 1 ? '1 hour a day' : hours + ' hours a day');
  return [kind, spell].filter(Boolean).join(', ');
}

function catalogError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function catalogRequest(suffix) {
  const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    options.signal = AbortSignal.timeout(TIMEOUT);
  }

  let res;
  try {
    res = await fetch(CATALOG + suffix, options);
  } catch (e) {
    throw catalogError(0, e.name === 'TimeoutError' ? 'the Pi did not answer'
                                                    : 'no connection to the Pi');
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch (e) { /* not JSON */ }
    throw catalogError(res.status, detail || ('the server returned ' + res.status));
  }
  return res.json();
}

/* ---------- searching ---------- */

const catalogFilters = () => {
  const filters = {
    q: $('#cat-q').value.trim(),
    temp: $('#cat-temp').value.trim(),
    ph: $('#cat-ph').value.trim(),
    height: $('#cat-height').value.trim(),
    kind: $('#cat-kind').value,
  };
  // '1' rather than true, because these go straight into the query string and
  // the server is strict about what a flag is allowed to say.
  for (const name of Object.keys(CATALOG_MARKS)) {
    filters[name] = $('#cat-' + name).checked ? '1' : '';
  }
  return filters;
};

let catalogTimer = null;
let catalogRun = 0;              // replies from an older keystroke are dropped

function queueCatalogSearch(wait) {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(runCatalogSearch, wait);
}

async function runCatalogSearch() {
  const filters = catalogFilters();
  const params = new URLSearchParams();
  for (const name of Object.keys(filters)) {
    if (filters[name]) params.set(name, filters[name]);
  }

  const query = params.toString();
  const mine = ++catalogRun;

  let doc;
  try {
    doc = await catalogRequest(query ? '?' + query : '');
  } catch (e) {
    if (mine !== catalogRun) return;
    return drawCatalogProblem(e);
  }
  if (mine !== catalogRun) return;      // a later search already answered
  drawCatalog(doc, filters);
}

/**
 * Why a filter found nothing, in the catalogue's own terms.
 *
 * Four entries in five record no temperature at all, and that is a fact about
 * an encyclopedia rather than about the search — worth saying, or the tool
 * looks broken every time it is asked something reasonable.
 */
function noMatchReason(doc, filters) {
  const cover = doc.coverage || {};
  const said = [];
  const note = (asked, n, what) => { if (asked && n) said.push('only ' + n + ' ' + what); };

  note(filters.temp, cover.temp, 'record a temperature');
  note(filters.ph, cover.ph, 'record a soil pH');
  note(filters.height, cover.height, 'record a height');
  note(filters.kind, cover.light, 'record the kind of light');
  for (const name of Object.keys(CATALOG_MARKS)) {
    note(filters[name], cover[name], 'are marked ' + CATALOG_MARKS[name].toLowerCase());
  }

  if (!said.length || !cover.total) return '';
  const last = said.pop();
  const list = said.length ? said.join(', ') + ' and ' + last : last;
  return 'Of the ' + cover.total + ' entries, ' + list + '.';
}

function drawCatalog(doc, filters) {
  const list = $('#cat-list');
  list.textContent = '';
  for (const entry of doc.results) list.appendChild(catalogRow(entry));

  $('#cat-error').hidden = true;
  $('#cat-error').textContent = '';

  const shown = doc.results.length;
  const count = $('#cat-count');
  count.hidden = shown === 0;
  count.textContent = doc.total === shown
    ? doc.total + (doc.total === 1 ? ' entry' : ' entries')
    : doc.total + ' entries · showing the first ' + shown;

  const empty = $('#cat-empty');
  empty.hidden = shown > 0;
  if (!shown) {
    empty.textContent = 'Nothing matches.';
    const why = noMatchReason(doc, filters);
    if (why) {
      const line = document.createElement('span');
      line.textContent = why;
      empty.appendChild(document.createElement('br'));
      empty.appendChild(line);
    }
  }
}

function drawCatalogProblem(err) {
  $('#cat-list').textContent = '';
  $('#cat-count').hidden = true;
  $('#cat-count').textContent = '';

  // A complaint about what was typed belongs under the boxes; anything else is
  // about the Pi, and belongs where the results would have been.
  const mistyped = err.status === 400;
  $('#cat-error').hidden = !mistyped;
  $('#cat-error').textContent = mistyped ? err.message : '';

  const empty = $('#cat-empty');
  empty.hidden = mistyped;
  empty.textContent = mistyped ? '' : 'Cannot search the catalogue — ' + err.message + '.';
}

function catalogRow(entry) {
  const li = document.createElement('li');

  const a = document.createElement('a');
  a.href = '#/c/' + encodeURIComponent(entry.pageId);

  const text = document.createElement('div');
  text.className = 'text';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.title;
  text.appendChild(name);

  const ph = phText(entry);
  // Height leads: the line is one truncated row and a plant that records its
  // temperature band, its limits and its light fills that on a phone before
  // it gets to the end. Of the facts here it is the shortest and the one you
  // can act on without reading the rest — it either fits the shelf or it does
  // not — so it is the one that has to survive the ellipsis.
  const summary = [heightText(entry), tempText(entry), ph && 'pH ' + ph,
                   catalogLightText(entry), humidityText(entry)]
                  .filter(Boolean).join(' · ');

  const row = document.createElement('div');
  row.className = 'flags';
  const marks = fillMarks(row, entry);

  const sub = document.createElement('div');
  sub.className = 'sub';
  // "A name only" would be a lie on a row that is carrying a mark or two.
  sub.textContent = summary ||
    (marks.length ? '' : 'A name only — no figures recorded');
  text.appendChild(sub);
  if (marks.length) text.appendChild(row);

  a.appendChild(text);
  li.appendChild(a);
  return li;
}

function renderCatalog() {
  // The boxes are left exactly as they were: coming back from an entry should
  // land on the search that found it, not on a blank form.
  queueCatalogSearch(0);
  show('catalog', 'Catalogue');
}

/* ---------- one entry ---------- */

async function renderCatalogEntry(pageId) {
  show('catalog-detail', 'Catalogue');

  const fields = ['#c-title', '#c-binomial', '#c-temp', '#c-humidity', '#c-ph',
                  '#c-light', '#c-height', '#c-family', '#c-zone', '#c-flags',
                  '#c-ratings', '#c-uses', '#c-notes', '#c-lead', '#c-meta'];
  for (const sel of fields) $(sel).textContent = '';

  $('#c-add').textContent = 'Add as a species';

  const mine = ++catalogRun;
  let entry;
  try {
    entry = await catalogRequest('/' + encodeURIComponent(pageId));
  } catch (e) {
    if (mine !== catalogRun) return;
    $('#c-title').textContent = 'Cannot open this entry';
    $('#c-binomial').textContent = e.message + '.';
    return;
  }
  if (mine !== catalogRun) return;

  $('#c-title').textContent = entry.title;
  $('#c-binomial').textContent =
    [entry.binomial !== entry.title ? entry.binomial : '', entry.genus]
      .filter(Boolean).join(' · ');

  fill($('#c-temp'), tempText(entry), 'Not recorded');
  // A minimum read off a hardiness zone is a coarser figure than one an editor
  // wrote in a sentence, and 1,323 of the entries have one.
  const zoned = $('#c-temp-from');
  zoned.hidden = !entry.fromZone;
  zoned.textContent = entry.fromZone ? 'from a zone' : '';

  fill($('#c-humidity'), humidityText(entry), 'Not recorded');
  const ph = phText(entry);
  fill($('#c-ph'), ph && 'pH ' + ph, 'Not recorded');
  // The same warning, for the same reason. pfaf.org states soil as named
  // bands rather than numbers, so 1,043 of the 1,278 entries that carry a pH
  // carry the edges of a band somebody named — 6.0-8.5 is "mildly acid to
  // mildly alkaline" and not a figure anyone measured.
  const banded = $('#c-ph-from');
  banded.hidden = !entry.phFromBands;
  banded.textContent = entry.phFromBands ? 'from soil bands' : '';
  fill($('#c-light'), catalogLightText(entry), 'Not recorded');
  fill($('#c-height'), heightText(entry), 'Not recorded');
  fill($('#c-family'), entry.family, 'Not recorded');
  fill($('#c-zone'), entry.zone && 'Zone ' + entry.zone, 'Not recorded');

  // The paragraph is not always a recipe: 23 entries carry one with neither
  // flag set, because what the article had to say was a warning. Those are
  // worth reading more than the rest, so an unmarked entry still shows it.
  const marks = fillMarks($('#c-flags'), entry);
  $('#c-flags').hidden = !marks.length;
  const rated = fillRatings($('#c-ratings'), entry);
  const uses = $('#c-uses');
  uses.hidden = !entry.uses && (marks.length > 0 || rated);
  fill(uses, entry.uses, 'Nothing recorded');

  fill($('#c-notes'), entry.notes, 'Nothing quotable in the article');
  fill($('#c-lead'), entry.lead, 'No lead stored');
  // A page id is Wikipedia's, so a plant Wikipedia has no article for cannot
  // have one — `plants_db --promote` gives those a negative id precisely
  // because a key that is obviously not a page id cannot collide with a real
  // one. Naming it or linking to it would both be lies, so neither happens.
  const article = entry.pageId > 0;
  $('#c-meta').textContent = [article ? 'Wikipedia page ' + entry.pageId : '',
                              CATALOG_SOURCE[entry.source],
                              'known here as ' + (entry.aliases || []).join(', ')]
                             .filter(Boolean).join(' · ');

  const wiki = $('#c-wiki');
  wiki.hidden = !article;
  wiki.href = article
    ? 'https://en.wikipedia.org/?curid=' + encodeURIComponent(entry.pageId) : '#';

  // The way out of the catalogue and into your own records. It says which
  // species it would fill, because filling one you already keep is the common
  // case and silently editing it would be a surprise.
  const existing = speciesForEntry(entry);
  const add = $('#c-add');
  add.href = '#/s/from/' + encodeURIComponent(entry.pageId);
  add.textContent = existing ? 'Fill in ' + existing.name : 'Add as a species';
}

/* =========================================================================
   Seeds

   A sowing is a batch: so many seeds of one kind, put into one tray on one
   day. It is deliberately not a plant. A plant is a thing you water; a sowing
   is a small experiment whose result arrives a few seeds at a time over a
   fortnight, and which may never produce a plant at all.

   That is why a sowing carries running tallies rather than a status:

     count      how many seeds went in
     sprouted   how many have come up since
     dead       how many rotted, or never came
     days       what the packet promises, so the app knows when to ask

   Still trying is what is left: count - sprouted - dead. A sowing is finished
   when that reaches zero, and the percentages are per seed rather than per
   batch, which is the only way "four of twelve came up" can be recorded
   honestly.

   Sowings are a third list beside plants and species, of exactly the same
   shape — id, updatedAt, a deletedAt tombstone — and are merged by the same
   code on both ends. Potting one up creates ordinary plants, linked back by
   `sowingId`; nothing else about a plant knows or cares where it came from.
   ========================================================================= */

const liveSowings = () => sowings.filter((s) => !s.deletedAt);

/** A count as it is worth trusting: a whole number, never below zero. */
function whole(value) {
  const n = Math.floor(Number(value));
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * The four numbers a sowing comes down to.
 *
 * The tallies are clamped against the batch rather than taken at face value:
 * two phones that both potted up the last seedling would otherwise merge into
 * a sowing claiming more seedlings than seeds.
 */
function tally(sowing) {
  const sown = whole(sowing.count);
  const up = Math.min(whole(sowing.sprouted), sown);
  const dead = Math.min(whole(sowing.dead), sown - up);
  return { sown: sown, up: up, dead: dead, trying: sown - up - dead };
}

/** The running total across several sowings, in the same shape. */
const sumTallies = (list) =>
  list.reduce((acc, sowing) => {
    const t = tally(sowing);
    acc.sown += t.sown; acc.up += t.up; acc.dead += t.dead; acc.trying += t.trying;
    return acc;
  }, { sown: 0, up: 0, dead: 0, trying: 0 });

/**
 * The species this sowing is of, or null.
 *
 * The id is resolved first, as on a plant, but a sowing that only ever had a
 * name typed into it is looked up by that name as well: seeds are usually in
 * before the species record is, and a sowing that quietly joins its species
 * once one exists is friendlier than one that has to be edited to notice.
 */
const sowingSpecies = (sowing) =>
  (sowing.speciesId && speciesById.get(sowing.speciesId)) ||
  (sowing.species ? speciesByName(sowing.species) : null);

const sowingName = (sowing) => {
  const parent = sowingSpecies(sowing);
  return (parent && parent.name) || sowing.species || 'Unnamed sowing';
};

/** The day the packet says they should be through, or '' when unstated. */
function expectedKey(sowing) {
  const days = whole(sowing.days);
  return days && sowing.sownOn ? addDays(sowing.sownOn, days) : '';
}

/** Whole days past the expected day; 0 on the day itself and before it. */
function sowingLate(sowing, today) {
  const expected = expectedKey(sowing);
  return expected ? Math.max(0, daysBetween(expected, today)) : 0;
}

/** Seeds still under the soil, and the day they were promised has come. */
function sowingDue(sowing, today) {
  if (tally(sowing).trying < 1) return false;
  const expected = expectedKey(sowing);
  return !!expected && daysBetween(expected, today) >= 0;
}

const seedsDue = (today) =>
  liveSowings()
    .filter((s) => sowingDue(s, today))
    .sort((a, b) => sowingLate(b, today) - sowingLate(a, today) ||
                    sowingName(a).localeCompare(sowingName(b), undefined,
                                               { sensitivity: 'base' }));

/** Soonest expected first; a sowing with no expected day waits at the back. */
const sowOrder = (a, b) => {
  const ea = expectedKey(a) || '9999-12-31';
  const eb = expectedKey(b) || '9999-12-31';
  if (ea !== eb) return ea < eb ? -1 : 1;
  return sowingName(a).localeCompare(sowingName(b), undefined, { sensitivity: 'base' });
};

/** Finished sowings read as a log, so the most recent one is at the top. */
const sowRecent = (a, b) => String(b.sownOn || '').localeCompare(String(a.sownOn || ''));

/** "Expected today", "3 days late", or what is left when no day was given. */
function expectedText(sowing, today) {
  const expected = expectedKey(sowing);
  const trying = tally(sowing).trying;
  if (!expected) return trying + (trying === 1 ? ' seed still to come' : ' seeds still to come');

  const away = daysBetween(today, expected);
  if (away === 0) return 'Expected today';
  if (away === 1) return 'Expected tomorrow';
  if (away > 1) return 'Expected ' + fmtDayKey(expected);
  return -away === 1 ? '1 day late' : -away + ' days late';
}

/** One line of plain English about where a sowing stands. */
function sowingStatus(sowing, today) {
  const t = tally(sowing);
  if (!t.sown) return 'Nothing recorded';
  if (t.trying < 1) return t.up + ' up, ' + t.dead + ' lost';
  const sofar = t.up || t.dead ? t.up + ' up so far' : '';
  return [sofar, expectedText(sowing, today)].filter(Boolean).join(' · ');
}

/* ---------- the bar, and the three percentages under it ---------- */

/**
 * Percentages that always add to a hundred.
 *
 * Two of the three are rounded and the third takes what is left, because
 * three independently rounded numbers under a bar drawn from the exact ones
 * is how you end up printing 101%. "Still trying" is the residual while there
 * is one, since it is the number that is still moving.
 */
function percentages(t) {
  if (t.sown < 1) return { up: 0, dead: 0, trying: 0 };
  const up = Math.round(t.up / t.sown * 100);
  let dead = t.trying < 1 ? 100 - up : Math.round(t.dead / t.sown * 100);
  let trying = 100 - up - dead;
  if (trying < 0) { dead += trying; trying = 0; }
  return { up: up, dead: dead, trying: trying };
}

/** The stacked bar: three parts of one batch, drawn from the exact counts. */
function renderBar(node, t) {
  node.textContent = '';
  node.hidden = t.sown < 1;
  if (node.hidden) return;

  for (const part of [['up', t.up], ['dead', t.dead], ['trying', t.trying]]) {
    const span = document.createElement('span');
    span.className = part[0];
    span.style.width = (part[1] / t.sown * 100) + '%';
    span.hidden = part[1] < 1;
    node.appendChild(span);
  }
}

/** "33% came up · 25% died · 42% still trying", the figures picked out. */
function fillSplit(node, t) {
  node.textContent = '';
  const pct = percentages(t);
  const parts = [[pct.up, 'came up'], [pct.dead, 'died'], [pct.trying, 'still trying']];

  parts.forEach((part, i) => {
    if (i) node.appendChild(document.createTextNode(' · '));
    const figure = document.createElement('b');
    figure.textContent = part[0] + '%';
    node.appendChild(figure);
    node.appendChild(document.createTextNode(' ' + part[1]));
  });
}

/**
 * Every species something has been sown of, with its seeds pooled.
 *
 * Grouped by species record where there is one and by the name that was typed
 * where there is not, so sowings of the same thing land together whether or
 * not a record existed at the time. Biggest batch first: the species you have
 * sown most of is the one whose success rate you actually have a figure for.
 */
function seedStats() {
  const groups = new Map();

  for (const sowing of liveSowings()) {
    const parent = sowingSpecies(sowing);
    const name = sowingName(sowing);
    const key = parent ? parent.id : 'name:' + name.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { name: name, id: parent ? parent.id : '', list: [] });
    }
    groups.get(key).list.push(sowing);
  }

  return Array.from(groups.values())
    .map((group) => Object.assign(group, { total: sumTallies(group.list) }))
    .filter((group) => group.total.sown > 0)
    .sort((a, b) => b.total.sown - a.total.sown ||
                    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Everything sown of one species, for the block on its own page. */
const seedsOfSpecies = (record) =>
  liveSowings().filter((s) => {
    const parent = sowingSpecies(s);
    return parent && parent.id === record.id;
  });

/** One block of the stats: who, the bar, the three figures. */
function tallyBlock(group, isTotal) {
  const box = document.createElement('div');
  box.className = 'tally' + (isTotal ? ' total' : '');

  const who = document.createElement('div');
  who.className = 'who';

  const name = document.createElement('span');
  name.textContent = group.name;
  who.appendChild(name);

  const n = document.createElement('span');
  n.className = 'n';
  const batches = group.list.length;
  n.textContent = group.total.sown + ' seeds · ' +
                  (batches === 1 ? '1 sowing' : batches + ' sowings');
  who.appendChild(n);
  box.appendChild(who);

  const bar = document.createElement('div');
  bar.className = 'bar';
  renderBar(bar, group.total);
  box.appendChild(bar);

  const split = document.createElement('p');
  split.className = 'split';
  fillSplit(split, group.total);
  box.appendChild(split);

  return box;
}

/* ---------- lists ---------- */

function sowingRow(sowing, today) {
  const li = document.createElement('li');

  const a = document.createElement('a');
  a.href = '#/seed/' + encodeURIComponent(sowing.id);

  const text = document.createElement('div');
  text.className = 'text';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = sowingName(sowing);
  text.appendChild(name);

  const t = tally(sowing);
  const sub = document.createElement('div');
  sub.className = 'sub' + (sowingLate(sowing, today) > 0 ? ' late' : '');
  sub.textContent = [t.sown + (t.sown === 1 ? ' seed' : ' seeds'),
                     sowingStatus(sowing, today)].filter(Boolean).join(' · ');
  text.appendChild(sub);

  a.appendChild(text);
  li.appendChild(a);
  return li;
}

function renderSeeds() {
  const today = todayKey();
  const all = liveSowings();
  const open = all.filter((s) => tally(s).trying > 0).sort(sowOrder);
  const done = all.filter((s) => tally(s).trying < 1).sort(sowRecent);

  const fillList = (selector, heading, items) => {
    const ul = $(selector);
    ul.textContent = '';
    for (const sowing of items) ul.appendChild(sowingRow(sowing, today));
    $(heading).hidden = items.length === 0;
  };

  fillList('#seeds-open', '#seeds-open-heading', open);
  fillList('#seeds-done', '#seeds-done-heading', done);
  $('#no-seeds').hidden = all.length > 0;

  // The stats are the point of keeping any of this, but they need something to
  // be a fraction of: with one sowing they would only ever read 0% or 100%.
  const stats = seedStats();
  const box = $('#seeds-stats');
  box.textContent = '';
  $('#seeds-stats-heading').hidden = stats.length === 0;

  if (stats.length) {
    if (stats.length > 1) {
      box.appendChild(tallyBlock({
        name: 'All seeds',
        list: all,
        total: sumTallies(all)
      }, true));
    }
    for (const group of stats) box.appendChild(tallyBlock(group, false));
  }

  show('seeds', open.length ? `Seeds (${open.length})` : 'Seeds');
}

/* ---------- one sowing ---------- */

function renderSeedDetail(id) {
  const sowing = sowings.find((x) => x.id === id && !x.deletedAt);
  if (!sowing) {
    location.replace('#/seeds');    // no history entry for a sowing that is gone
    return;
  }

  const today = todayKey();
  const t = tally(sowing);
  const parent = sowingSpecies(sowing);

  $('#q-name').textContent = sowingName(sowing);

  const link = $('#q-species-from');
  fill($('#q-species'), parent ? parent.name : sowing.species, 'Not set');
  link.hidden = !parent;
  if (parent) {
    link.textContent = 'open';
    link.href = '#/s/' + encodeURIComponent(parent.id);
  }

  fill($('#q-sown'), sowing.sownOn
    ? t.sown + (t.sown === 1 ? ' seed on ' : ' seeds on ') + fmtDayKey(sowing.sownOn)
    : '', 'Not set');

  const expected = expectedKey(sowing);
  const late = sowingLate(sowing, today);
  const expectedVal = $('#q-expected');
  fill(expectedVal, expected
    ? fmtDayKey(expected) + (t.trying > 0 && late > 0
        ? ' · ' + (late === 1 ? '1 day late' : late + ' days late') : '')
    : '', 'No germination time given');
  expectedVal.classList.toggle('late', t.trying > 0 && late > 0);

  // Plants standing are seedlings that cannot be typed away, so they are
  // counted apart from the box and shown beside it: 4 + 2 potted is what
  // makes the six that came up add up against the rest of the tray.
  const mine = live().filter((p) => p.sowingId === sowing.id).sort(byName);
  const potted = mine.length;

  complain('#q-count-error', '');
  complain('#q-pot-error', '');

  setTally($('#q-sprouted'), Math.max(0, t.up - potted), t.sown - potted - t.dead);
  setTally($('#q-dead'), t.dead, t.sown - t.up);
  $('#q-potted').textContent = potted ? '+ ' + potted + ' potted up' : '';

  $('#q-sprouted').onchange = () => editTally(sowing.id, 'up');
  $('#q-dead').onchange = () => editTally(sowing.id, 'dead');

  fill($('#q-trying'), t.trying > 0 ? String(t.trying) : 'None — this sowing is finished', '0');

  renderBar($('#q-bar'), t);
  fillSplit($('#q-bar-text'), t);
  $('#q-bar-wrap').hidden = t.sown < 1;

  // Nothing left that could become a plant, nothing to pot up. The boxes
  // above stay open either way: a finished sowing is exactly the one whose
  // figures you may need to correct.
  const room = t.sown - potted - t.dead;
  const pot = $('#q-pot');
  pot.hidden = room < 1;
  if (!pot.hidden) {
    // Clamped rather than reset: a sync landing between typing a number and
    // tapping the button must not change the number the button is about.
    const box = $('#q-up-n');
    box.max = room;
    if (document.activeElement !== box) {
      box.value = Math.min(whole(box.value) || 1, room);
    }
    $('#q-up-plant').onclick = () => potUpSome(sowing.id, box.value);
  }

  fill($('#q-notes'), sowing.notes, 'No notes');

  const ul = $('#q-plants');
  ul.textContent = '';
  for (const plant of mine) ul.appendChild(plantRow(plant, today, false));
  $('#q-plants-heading').hidden = !mine.length;

  $('#q-meta').textContent = sowing.createdAt ? 'Recorded ' + fmtDate(sowing.createdAt) : '';

  $('#q-edit').href = '#/seed/' + encodeURIComponent(sowing.id) + '/edit';
  $('#q-delete').onclick = () => {
    if (!confirm(`Delete this sowing of ${sowingName(sowing)}?` +
                 (mine.length ? ' The plants it produced are kept.' : ''))) return;
    sowing.deletedAt = new Date().toISOString();
    sowing.updatedAt = sowing.deletedAt;
    commit();
    replaceRoute('#/seeds');       // Back must not return to what was deleted
  };

  show('seed-detail', sowingName(sowing));
}

/* ---------- what came of it ---------- */

/**
 * Complains next to the box it is about rather than in the status bar, which
 * sits at the top of the screen and would be off it by the time you have
 * scrolled down to the tallies.
 */
function complain(where, message) {
  const line = $(where);
  line.textContent = message;
  line.hidden = !message;
}

/**
 * Puts a figure in its box, unless that box is the one being typed into: a
 * sync landing mid-edit must not reach up and change the number under your
 * thumb. The ceiling goes on as well, so the phone keypad's own stepper
 * cannot climb past what the tray holds.
 */
function setTally(box, n, max) {
  box.max = Math.max(0, max);
  box.classList.remove('invalid');
  if (document.activeElement !== box) box.value = n;
}

/** How many plants this sowing has produced and still has standing. */
const pottedFrom = (sowing) => live().filter((p) => p.sowingId === sowing.id).length;

/**
 * Takes one of the two tallies as typed.
 *
 * `which` is 'up' for the seedlings box, which holds only the ones that have
 * not been potted up: plants are seedlings the tray has already accounted
 * for, and typing 0 over them would lose the fact that they ever came up.
 * The stored figure stays the whole of what came up, potted or not.
 */
function editTally(id, which) {
  const sowing = sowings.find((x) => x.id === id && !x.deletedAt);
  if (!sowing) return;

  const box = $(which === 'dead' ? '#q-dead' : '#q-sprouted');
  const t = tally(sowing);
  const potted = pottedFrom(sowing);

  // Everything this box is not allowed to spend: the other tally, and, for
  // the seedlings box, the plants standing in the ground.
  const room = t.sown - (which === 'dead' ? t.up : potted + t.dead);
  const n = Math.floor(Number(String(box.value).trim()));

  const problem =
    !isFinite(n) || n < 0 ? 'That does not read as a number of seeds.'
    : n > room ? (room === 0
        ? 'Every seed in this sowing is already accounted for.'
        : `There ${room === 1 ? 'is' : 'are'} only ${room} left to account for.`)
    : '';

  box.classList.toggle('invalid', !!problem);
  complain('#q-count-error', problem);
  if (problem) return;      // left as typed, so the digit can be corrected

  sowing[which === 'dead' ? 'dead' : 'sprouted'] = which === 'dead' ? n : potted + n;
  sowing.updatedAt = new Date().toISOString();
  commit();
}

/**
 * Pot up n seedlings: one plant each, already following the species.
 *
 * They are numbered when the sowing has produced more than one, because a
 * tray of six identical "Basil" rows is unreadable, and a single seedling
 * called "Basil 1" reads as though five more are coming.
 */
function potUp(sowing, n) {
  const parent = sowingSpecies(sowing);
  const speciesName = (parent && parent.name) || sowing.species || '';
  const base = speciesName || 'Seedling';
  const existing = pottedFrom(sowing);
  const now = new Date().toISOString();

  for (let i = 0; i < n; i++) {
    plants.push({
      id: uid(),
      name: existing + n > 1 ? base + ' ' + (existing + i + 1) : base,
      species: speciesName,
      speciesId: parent ? parent.id : '',
      sowingId: sowing.id,
      place: '',
      temps: null, humidity: null, ph: null, light: null,
      schedule: null,
      water: '', notes: '',
      createdAt: now, updatedAt: now
    });
  }
}

/**
 * Pot up n seedlings and account for them.
 *
 * Seedlings already counted are promoted first — they came up once and must
 * not be counted twice — and only what is left over is taken from the seeds
 * still under the soil. Which is what `max` says: what came up is never less
 * than the number of plants that came out of it.
 */
function potUpSome(id, raw) {
  const sowing = sowings.find((x) => x.id === id && !x.deletedAt);
  if (!sowing) return;

  const t = tally(sowing);
  const potted = pottedFrom(sowing);
  const room = t.sown - potted - t.dead;
  const n = Math.floor(Number(String(raw).trim()));

  if (!isFinite(n) || n < 1) {
    return complain('#q-pot-error', 'That does not read as a number of seedlings.');
  }
  if (n > room) {
    return complain('#q-pot-error',
      `There ${room === 1 ? 'is' : 'are'} only ${room} left to pot up.`);
  }

  complain('#q-pot-error', '');
  potUp(sowing, n);
  sowing.sprouted = Math.max(t.up, potted + n);
  sowing.updatedAt = new Date().toISOString();
  commit();
  setStatus(n === 1 ? 'Potted up 1 seedling.' : 'Potted up ' + n + ' seedlings.', false);
}

/* ---------- sowing something, and editing what was sown ---------- */

let sowingIsNew = false;

/**
 * Says what naming a species buys, and offers the germination time the last
 * sowing of it needed. Days to come up is a fact about the kind of seed, so
 * on a new sowing the box is filled in rather than merely hinted at — it is
 * what puts the sowing on the Seeds due list, and an empty box quietly opts
 * out of the whole feature.
 */
function applySeedSpecies() {
  const typed = $('#q-f-species').value.trim();
  const parent = speciesByName(typed);
  const hint = $('#q-f-species-hint');

  if (!typed) {
    hint.textContent = 'Optional. Naming one pools this sowing with the rest of ' +
                       'its kind in the figures below the list.';
  } else if (parent) {
    hint.textContent = 'Linked to ' + parent.name +
                       '. Seedlings potted up from here follow it.';
  } else {
    hint.textContent = 'No species called that yet — the sowing keeps the name ' +
                       'either way, and joins the record if you add one later.';
  }

  const days = lastGerminationDays(typed);
  const box = $('#q-f-days');
  box.placeholder = days ? String(days) : '7';
  if (sowingIsNew && days && !box.value) box.value = days;

  return parent;
}

/** How long the last sowing of this name took to be given up on, or 0. */
function lastGerminationDays(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return 0;

  const seen = liveSowings()
    .filter((s) => whole(s.days) && sowingName(s).toLowerCase() === wanted)
    .sort(sowRecent);
  return seen.length ? whole(seen[0].days) : 0;
}

function renderSeedForm(id) {
  const sowing = id ? sowings.find((x) => x.id === id && !x.deletedAt) : null;
  if (id && !sowing) {
    location.replace('#/seeds');
    return;
  }

  const form = $('#seed-form');
  form.reset();
  sowingIsNew = !sowing;

  $('#q-f-species').value = sowing ? sowing.species || '' : '';
  $('#q-f-count').value = sowing ? whole(sowing.count) || '' : '';
  $('#q-f-date').value = sowing ? sowing.sownOn || '' : todayKey();
  $('#q-f-days').value = sowing ? whole(sowing.days) || '' : '';
  $('#q-f-notes').value = sowing ? sowing.notes || '' : '';
  $('#q-f-error').hidden = true;
  applySeedSpecies();

  const complain = (message, focus) => {
    const line = $('#q-f-error');
    line.textContent = message;
    line.hidden = false;
    $(focus).focus();
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    $('#q-f-error').hidden = true;

    const count = Math.floor(Number(String($('#q-f-count').value).trim()));
    if (!isFinite(count) || count < 1) {
      return complain('How many seeds went in?', '#q-f-count');
    }

    const sownOn = $('#q-f-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sownOn)) {
      return complain('Which day did they go in?', '#q-f-date');
    }

    const rawDays = String($('#q-f-days').value).trim();
    const days = rawDays === '' ? null : Math.floor(Number(rawDays));
    if (days !== null && (!isFinite(days) || days < 1)) {
      return complain('That does not read as a number of days.', '#q-f-days');
    }

    // Editing the batch down below what has already been recorded would make
    // the percentages lie, so it is refused rather than silently clamped.
    if (sowing) {
      const settled = tally(sowing).up + tally(sowing).dead;
      if (count < settled) {
        return complain(`${settled} of these are already accounted for, so the ` +
                        `batch cannot be smaller than that.`, '#q-f-count');
      }
    }

    const now = new Date().toISOString();
    const speciesName = $('#q-f-species').value.trim();
    const parent = speciesByName(speciesName);
    const fields = {
      species: speciesName,
      speciesId: parent ? parent.id : '',
      count: count,
      sownOn: sownOn,
      days: days,
      notes: $('#q-f-notes').value.trim(),
      updatedAt: now
    };

    let saved = sowing;
    if (sowing) {
      Object.assign(sowing, fields);
    } else {
      saved = Object.assign({ id: uid(), sprouted: 0, dead: 0, createdAt: now }, fields);
      sowings.push(saved);
    }

    commit();
    // As on the plant form: a submitted form must not stay in history.
    if (sowing && cameFrom === '/seed/' + sowing.id) {
      history.back();
    } else {
      replaceRoute('#/seed/' + encodeURIComponent(saved.id));
    }
  };

  $('#q-f-cancel').onclick = () => history.back();

  show('seed-edit', sowing ? 'Edit sowing' : 'Sow seeds');
  if (!sowing) setTimeout(() => $('#q-f-species').focus(), 50);
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
  const sown = liveSowings().length;
  $('#s-count').textContent =
    `${count} plant${count === 1 ? '' : 's'}, ${kinds} ` +
    `species and ${sown} sowing${sown === 1 ? '' : 's'} cached on this device` +
    (dirty ? ', with changes waiting to sync.' : '.');

  show('settings', 'Settings');
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
$('#q-f-species').oninput = applySeedSpecies;

// Anything typed arrives a character at a time, and a lone "-" is not a
// temperature, so it waits for a pause. Anything picked searches at once.
$('#cat-q').oninput = () => queueCatalogSearch(CATALOG_WAIT);
$('#cat-temp').oninput = () => queueCatalogSearch(CATALOG_WAIT);
$('#cat-ph').oninput = () => queueCatalogSearch(CATALOG_WAIT);
$('#cat-height').oninput = () => queueCatalogSearch(CATALOG_WAIT);
$('#cat-kind').onchange = () => queueCatalogSearch(0);
for (const name of Object.keys(CATALOG_MARKS)) {
  $('#cat-' + name).onchange = () => queueCatalogSearch(0);
}

// Enter on a phone keyboard submits; there is nothing to submit, and letting
// it through would reload the page and lose the whole search.
$('#cat-form').onsubmit = (e) => {
  e.preventDefault();
  queueCatalogSearch(0);
};

$('#cat-clear').onclick = () => {
  $('#cat-form').reset();
  queueCatalogSearch(0);
};

$('#s-sync').onclick = () => sync();

$('#s-export').onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 3, species, plants, sowings }, null, 2)],
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
    // A backup taken before species or sowings existed simply has none to
    // bring back, which merges to what is already here.
    if (parsed && Array.isArray(parsed.species)) species = merge(species, parsed.species);
    if (parsed && Array.isArray(parsed.sowings)) sowings = merge(sowings, parsed.sowings);
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
  sowings = [];
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
