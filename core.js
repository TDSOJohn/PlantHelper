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

   `knownAs` is the exception that is not a fact about the plant at all: it is
   what *you* call the kind, typed by hand and empty until you do. Nothing
   matches on it, nothing fills it in, and no figure is read from it — a
   species is still joined by its botanical name alone. It exists because a
   list of binomials is hard to read and *Swiss cheese plant* is not.

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

