'use strict';

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
    // What you call it leads, where you have said. It is the only thing on
    // this line that is a name rather than a figure, and a list of binomials
    // is exactly where a common name earns its place.
    sub.textContent = [record.knownAs, speciesSummary(record),
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
  // Under the binomial rather than beside it: the heading is what a plant
  // joins by, and this is only what you call the thing. Absent where it was
  // never filled in, because "Not set" under a name reads as a missing figure
  // rather than as an empty box nobody had to type in.
  const known = $('#sd-known');
  known.hidden = !record.knownAs;
  known.textContent = record.knownAs || '';

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
  $('#sp-known').value = record ? record.knownAs || '' : '';
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
    const fields = { name, knownAs: $('#sp-known').value.trim(),
                     temps: figures.temps, humidity: figures.humidity,
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

