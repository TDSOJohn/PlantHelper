'use strict';

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

