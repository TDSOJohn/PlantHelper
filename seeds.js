'use strict';

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

