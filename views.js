'use strict';

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
 * a species, a sowing, a catalogue entry, and the forms that add or edit them.
 * That is the same question as which tab is lit, and is answered in the same
 * loop, so the bar is the only thing that has to be edited when one of these
 * moves. The new-plant form gained an arrow for free the moment it stopped
 * being a tab; the catalogue search lost one the moment it became one.
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

