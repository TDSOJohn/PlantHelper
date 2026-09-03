'use strict';

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

