'use strict';

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
for (const name of Object.keys(CATALOG_FIELDS)) {
  const node = $('#cat-' + name);
  if (CATALOG_FIELDS[name] === 'text') node.oninput = () => queueCatalogSearch(CATALOG_WAIT);
  else node.onchange = () => queueCatalogSearch(0);
}

// The panel starts shut and stays however it was left, the same way the boxes
// inside it do: coming back from an entry should land on the search that found
// it. Nothing is searched on opening or shutting it — the filters have not
// changed — but the button has to be redrawn, because its colour says whether
// what is set is currently out of sight.
$('#cat-toggle').onclick = () => {
  const panel = $('#cat-filters');
  panel.hidden = !panel.hidden;
  drawCatalogControls(catalogFilters());
};

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
