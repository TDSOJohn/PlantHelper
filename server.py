#!/usr/bin/env python3
"""
Plants — a small LAN-only server for the plant database.

Serves the static page, one JSON endpoint and the plant photos:

    GET    /api/plants        ->  {"version": 2, "updatedAt": "...",
                                   "species": [...], "plants": [...]}
    PUT    /api/plants        <-  {"species": [...], "plants": [...]}
    PUT    /api/photo/<id>    <-  raw JPEG bytes (the browser resizes to 512x512)
    DELETE /api/photo/<id>
    GET    /photos/<id>.jpg
    GET    /api/catalog?q=&temp=&ph=&kind=  ->  the reference catalogue
    GET    /api/catalog/<pageId>            ->  one entry in full

A PUT to /api/plants is *merged* with what is already on disk rather than
replacing it, so two phones that were both edited offline can sync in any order
without losing an edit. Species and plants are two lists of the same shape and
are merged the same way; either may be omitted by an older client, in which
case what is on disk is kept. Writes are atomic and a snapshot is kept once a day,
because SD cards and power cuts do not mix.

Standard library only — nothing to install on the Pi beyond Python itself.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_PATH = "/api/plants"
PHOTO_API = re.compile(r"^/api/photo/([A-Za-z0-9_-]{1,64})$")
PHOTO_FILE = re.compile(r"^/photos/([A-Za-z0-9_-]{1,64})\.jpg$")
CATALOG_API = re.compile(r"^/api/catalog(?:/([0-9]{1,12}))?$")

# What a plant id has to look like before it is turned into a file name. The
# two routes above get this from their own patterns; the sweep below needs it
# because the ids it works from come out of the request body, where "../.." is
# just as easy to write as anything else.
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

MAX_BODY = 4 * 1024 * 1024        # a plant list will never come close
MAX_PHOTO = 2 * 1024 * 1024       # a 512x512 JPEG is ~50 kB
BACKUP_KEEP = 30                  # daily snapshots to retain
HIDDEN = ("/data", "/backups")    # never served as static files
CATALOG_LIMIT = 60                # rows one search may return

_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def merge(current, incoming):
    """Union by id; the most recently updated copy of each record wins.

    Ties go to `incoming`, and deletes are tombstones (a record with a
    `deletedAt`), so a stale device cannot resurrect something you deleted.

    Nothing here is specific to plants: species records carry the same id,
    updatedAt and deletedAt fields, and are merged by the same call.
    """
    out = {}
    for record in list(current) + list(incoming):
        if not isinstance(record, dict):
            continue
        rid = record.get("id")
        if not isinstance(rid, str) or not rid:
            continue
        seen = out.get(rid)
        if seen is None or str(record.get("updatedAt") or "") >= str(seen.get("updatedAt") or ""):
            out[rid] = record
    return list(out.values())


class Store:
    """The plant list as a single JSON file, plus one JPEG per plant."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.backup_dir = os.path.join(self.dir, "backups")
        self.photo_dir = os.path.join(self.dir, "photos")
        os.makedirs(self.dir, exist_ok=True)

    # ---------- the plant list ----------

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                doc = json.load(handle)
        except FileNotFoundError:
            return {"version": 2, "updatedAt": None, "species": [], "plants": []}

        if isinstance(doc, list):          # tolerate a bare array
            doc = {"plants": doc}
        plants = doc.get("plants")
        species = doc.get("species")       # absent in a file written before v2
        return {
            "version": 2,
            "updatedAt": doc.get("updatedAt"),
            "species": species if isinstance(species, list) else [],
            "plants": plants if isinstance(plants, list) else [],
        }

    def save(self, plants, species):
        doc = {"version": 2, "updatedAt": now_iso(),
               "species": species, "plants": plants}
        text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
        self._snapshot()
        self._atomic_write(self.path, text.encode("utf-8"))
        return doc

    # ---------- photos ----------

    def photo_path(self, plant_id):
        return os.path.join(self.photo_dir, plant_id + ".jpg")

    def save_photo(self, plant_id, data):
        os.makedirs(self.photo_dir, exist_ok=True)
        self._atomic_write(self.photo_path(plant_id), data)

    def delete_photo(self, plant_id):
        try:
            os.unlink(self.photo_path(plant_id))
            return True
        except FileNotFoundError:
            return False

    def sweep_photos(self, plants):
        """Drop the photo of every plant that is now a tombstone.

        The browser fires a DELETE of its own when you delete a plant, but it
        is fire-and-forget: if the Pi is unreachable at that moment, or the
        phone was offline, the JPEG is left behind with nothing referencing it
        and nothing to retry. A `deletedAt` is final — tombstones exist so an
        offline phone cannot resurrect a plant — so the file is unreferenced
        for good, and the tombstone always reaches the server eventually.

        Returns the number of files removed.
        """
        removed = 0
        for plant in plants:
            if not isinstance(plant, dict) or not plant.get("deletedAt"):
                continue
            plant_id = plant.get("id")
            if not isinstance(plant_id, str) or not SAFE_ID.match(plant_id):
                continue
            try:
                if self.delete_photo(plant_id):
                    removed += 1
            except OSError:
                pass          # a stray file is not worth failing a sync over
        return removed

    # ---------- disk ----------

    def _atomic_write(self, path, data):
        """Write to a temp file in the same directory, fsync, then rename over
        the original: a power cut leaves either the old file or the new one,
        never a half-written one."""
        directory = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".part")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def _snapshot(self):
        """Keep one copy of the plant list per day, pruned to BACKUP_KEEP days."""
        if not os.path.exists(self.path):
            return
        os.makedirs(self.backup_dir, exist_ok=True)
        dest = os.path.join(self.backup_dir, "plants-%s.json" % datetime.now().strftime("%Y-%m-%d"))
        if os.path.exists(dest):
            return
        shutil.copy2(self.path, dest)

        kept = sorted(f for f in os.listdir(self.backup_dir) if f.endswith(".json"))
        for stale in kept[:-BACKUP_KEEP]:
            os.unlink(os.path.join(self.backup_dir, stale))


def like_escape(text):
    """% and _ are LIKE wildcards; a name typed with either should match itself."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class Catalog:
    """The reference catalogue: 5,065 species mined from Wikipedia by ../plants_db.

    Read-only, and deliberately not part of plants.json. It is the opposite
    kind of data: nobody edits it, it is rebuilt from scratch whenever the dump
    is re-mined, and losing it costs an afternoon rather than a plant. Keeping
    it out of the document also keeps the document syncable — a phone holds the
    whole of plants.json offline, and would not want 4 MB of encyclopedia.

    Nothing here writes. The file is opened read-only and never through the
    static file server either: /data is in HIDDEN.

    Queries are `SELECT *` and pick columns out by name, so a column added or
    renamed upstream costs nothing here unless it is one of the names below —
    and then it is a KeyError on the first request rather than a startup
    failure. The suite pins the read set for that reason. `section_name` is
    not among them: it says which heading a figure was read from, which is
    provenance for the extractor rather than anything to show.
    """

    # What a filter may ask about. Two shapes, because the data has two.
    #
    # BANDS: the recorded range has to cover the figure, with an unrecorded end
    # treated as open. Right for pH, where 192 of the 234 entries that record
    # one record both ends.
    #
    # FLOORS: the recorded minimum has to be at or below the figure. Right for
    # temperature, where 789 entries record how cold a plant takes and 63 how
    # hot: asked as a band, "survives 45 °C" matches 738 of them — every plant
    # whose ceiling simply nobody wrote down. That is a count of what the
    # encyclopedia is missing, dressed up as an answer.
    BANDS = {
        "ph": ("ph_min", "ph_max"),
        "humidity": ("humidity_min", "humidity_max"),
    }
    FLOORS = {
        "temp": "COALESCE(temp_abs_min, temp_avg_min)",
    }

    @classmethod
    def figures(cls):
        """Every filter that takes a number."""
        return tuple(cls.BANDS) + tuple(cls.FLOORS)

    # Wikipedia describes light four ways. The app's own records know only the
    # first two, so importing one of the others has to choose — but a search
    # over the catalogue should still be able to say what it means.
    KINDS = ("direct", "indirect", "partial", "shade")

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self._coverage = None

    def available(self):
        return os.path.exists(self.path)

    def _connect(self):
        """A fresh read-only connection per request.

        Each request already has a thread of its own and a sqlite3 connection
        may not cross one. Opening costs microseconds against a 4 MB file the
        page cache is holding anyway, so there is nothing worth pooling.
        """
        uri = "file:%s?mode=ro" % urllib.parse.quote(self.path)
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    # ---------- reading ----------

    def _shape(self, row, full=False):
        """One row in the shape the app's own records use.

        The four condition groups come back named exactly as a plant or species
        carries them, so the page can format a catalogue entry with the same
        code that formats your own plants. An empty group is left out rather
        than sent as a bag of nulls: absent already means unset everywhere else.
        """
        out = {"pageId": row["page_id"], "title": row["title"],
               "binomial": row["binomial"], "score": row["score"]}

        groups = {
            "temps": {"absMin": row["temp_abs_min"], "avgMin": row["temp_avg_min"],
                      "avgMax": row["temp_avg_max"], "absMax": row["temp_abs_max"]},
            "humidity": {"min": row["humidity_min"], "max": row["humidity_max"]},
            "ph": {"min": row["ph_min"], "max": row["ph_max"]},
            "light": {"hours": row["light_hours"], "kind": row["light_kind"]},
        }
        for name, bag in groups.items():
            kept = {key: value for key, value in bag.items() if value is not None}
            if kept:
                out[name] = kept

        if full:
            out["genus"] = row["genus"]
            out["family"] = row["family"]
            out["rank"] = row["rank"]
            out["zone"] = row["zone"]
            # Worth flagging: a minimum read off a hardiness zone is a coarser
            # figure than one an editor wrote in a sentence, and 453 rows have one.
            out["fromZone"] = bool(row["temp_abs_min_from_zone"])
            out["notes"] = row["notes"] or ""
            out["lead"] = row["lead"] or ""
        return out

    def search(self, terms):
        where, args = [], []

        wanted = terms.get("q", "")
        if wanted:
            where.append("page_id IN (SELECT page_id FROM alias"
                         " WHERE key LIKE ? ESCAPE '\\')")
            args.append("%" + like_escape(wanted) + "%")

        for name, (low, high) in self.BANDS.items():
            if name not in terms:
                continue
            # One end has to be recorded, or the 4,831 rows with no pH at all
            # would answer every pH question. The other end may be missing:
            # a range known only to start at 4.0 still says something about 6.5.
            where.append("(({low} IS NOT NULL OR {high} IS NOT NULL)"
                         " AND ({low} IS NULL OR {low} <= ?)"
                         " AND ({high} IS NULL OR {high} >= ?))"
                         .format(low=low, high=high))
            args += [terms[name], terms[name]]

        for name, low in self.FLOORS.items():
            if name not in terms:
                continue
            where.append("({low} IS NOT NULL AND {low} <= ?)".format(low=low))
            args.append(terms[name])

        if terms.get("kind"):
            where.append("light_kind = ?")
            args.append(terms["kind"])

        clause = (" WHERE " + " AND ".join(where)) if where else ""
        order, order_args = "score DESC, title", []
        if wanted:
            # A name typed in full should not sit below a better-documented
            # article that merely contains it.
            order = "CASE WHEN lower(title) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, " + order
            order_args.append(like_escape(wanted) + "%")

        conn = self._connect()
        try:
            total = conn.execute("SELECT COUNT(*) FROM species" + clause, args).fetchone()[0]
            rows = conn.execute(
                "SELECT * FROM species" + clause + " ORDER BY " + order + " LIMIT ?",
                args + order_args + [CATALOG_LIMIT]).fetchall()
        finally:
            conn.close()

        return {"total": total, "limit": CATALOG_LIMIT,
                "coverage": self.coverage(),
                "results": [self._shape(row) for row in rows]}

    def get(self, page_id):
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM species WHERE page_id = ?",
                               (page_id,)).fetchone()
            if row is None:
                return None
            record = self._shape(row, full=True)
            record["aliases"] = [r[0] for r in conn.execute(
                "SELECT key FROM alias WHERE page_id = ? ORDER BY key", (page_id,))]
            return record
        finally:
            conn.close()

    def coverage(self):
        """How many rows record each figure at all.

        Sent with every search so the page can say why a filter found little:
        four rows in five have no temperature, and that is a fact about
        Wikipedia rather than about the search. Cached because replacing the
        file means copying a new one over and restarting.
        """
        if self._coverage is not None:
            return self._coverage

        conn = self._connect()
        try:
            count = lambda sql: conn.execute(
                "SELECT COUNT(*) FROM species WHERE " + sql).fetchone()[0]
            self._coverage = {
                "total": conn.execute("SELECT COUNT(*) FROM species").fetchone()[0],
                "temp": count("temp_abs_min IS NOT NULL OR temp_avg_min IS NOT NULL"
                              " OR temp_avg_max IS NOT NULL OR temp_abs_max IS NOT NULL"),
                "ph": count("ph_min IS NOT NULL OR ph_max IS NOT NULL"),
                "light": count("light_kind IS NOT NULL"),
                "notes": count("notes IS NOT NULL AND notes != ''"),
            }
        finally:
            conn.close()
        return self._coverage


def catalog_terms(query):
    """Read a query string into search terms, or return a complaint about it.

    Returns (terms, "") or (None, message).
    """
    raw = urllib.parse.parse_qs(query)
    first = lambda name: (raw.get(name) or [""])[0].strip()
    terms = {}

    wanted = first("q").lower()
    if wanted:
        terms["q"] = wanted[:80]

    for name in Catalog.figures():
        text = first(name)
        if not text:
            continue
        try:
            # The comma, because a phone keypad offers one and the app accepts
            # it everywhere else a decimal is typed.
            value = float(text.replace(",", "."))
        except ValueError:
            return None, "'%s' is not a number" % name
        if value != value or value in (float("inf"), float("-inf")):
            return None, "'%s' is not a number" % name
        terms[name] = value

    kind = first("kind")
    if kind:
        if kind not in Catalog.KINDS:
            return None, "'kind' must be one of: " + ", ".join(Catalog.KINDS)
        terms["kind"] = kind

    return terms, ""


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"     # keep-alive: fewer round trips over Wi-Fi
    store = None
    catalog = None
    _own_cache = False                # set when a route sends its own Cache-Control

    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map[".webmanifest"] = "application/manifest+json"
    extensions_map[".md"] = "text/markdown; charset=utf-8"

    # ---------- routing ----------

    def do_GET(self):
        self._own_cache = False
        path = self._path()

        if path == API_PATH:
            return self._plants_get()

        catalog = CATALOG_API.match(path)
        if catalog:
            return self._catalog_get(catalog.group(1))

        photo = PHOTO_FILE.match(path)
        if photo:
            return self._photo_get(photo.group(1))

        if self._is_hidden():
            return self._fail(404, "Not found")
        return super().do_HEAD() if self.command == "HEAD" else super().do_GET()

    def do_HEAD(self):
        # Same routes as GET; _send_json and _photo_get omit the body themselves.
        return self.do_GET()

    def do_PUT(self):
        self._own_cache = False
        path = self._path()

        if path == API_PATH:
            return self._plants_put()

        photo = PHOTO_API.match(path)
        if photo:
            return self._photo_put(photo.group(1))

        return self._fail(405, "Method not allowed")

    do_POST = do_PUT

    def do_DELETE(self):
        self._own_cache = False
        photo = PHOTO_API.match(self._path())
        if photo:
            return self._photo_delete(photo.group(1))
        return self._fail(405, "Method not allowed")

    def _path(self):
        return urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"

    def _is_hidden(self):
        path = self._path()
        return "/." in path or any(path == h or path.startswith(h + "/") for h in HIDDEN)

    # ---------- the plant list ----------

    def _plants_get(self):
        with _lock:
            try:
                doc = self.store.load()
            except Exception as exc:                       # corrupt file: fail loudly
                return self._fail(500, "Cannot read the data file: %s" % exc)
        self._send_json(200, doc)

    def _plants_put(self):
        raw = self._read_body(MAX_BODY)
        if raw is None:
            return

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return self._fail(400, "Body is not valid JSON: %s" % exc)

        incoming = payload.get("plants") if isinstance(payload, dict) else payload
        if not isinstance(incoming, list):
            return self._fail(400, "Expected a JSON object with a 'plants' array")

        # A client that predates species simply does not mention them, which
        # has to leave the ones on disk alone rather than wipe them.
        incoming_species = payload.get("species") if isinstance(payload, dict) else None
        if incoming_species is None:
            incoming_species = []
        if not isinstance(incoming_species, list):
            return self._fail(400, "'species' must be an array if it is given")

        with _lock:
            try:
                current = self.store.load()
                merged = merge(current["plants"], incoming)
                merged_species = merge(current["species"], incoming_species)
                doc = self.store.save(merged, merged_species)
            except Exception as exc:
                return self._fail(500, "Cannot write the data file: %s" % exc)
            # Only once the list is safely on disk, and still under the lock so
            # this cannot overtake a photo upload arriving at the same moment.
            self.store.sweep_photos(merged)

        self._send_json(200, doc)

    # ---------- the reference catalogue ----------

    def _catalog_get(self, page_id):
        """Search the catalogue, or return one entry in full.

        No lock: the file is opened read-only and nothing in this process ever
        writes to it, so there is nothing for a reader to be caught between.
        """
        if self.catalog is None or not self.catalog.available():
            return self._fail(503, "No catalogue on this server")

        try:
            if page_id is not None:
                record = self.catalog.get(int(page_id))
                if record is None:
                    return self._fail(404, "No such entry in the catalogue")
                return self._send_json(200, record)

            terms, complaint = catalog_terms(urllib.parse.urlsplit(self.path).query)
            if complaint:
                return self._fail(400, complaint)
            return self._send_json(200, self.catalog.search(terms))
        except sqlite3.Error as exc:
            return self._fail(500, "Cannot read the catalogue: %s" % exc)

    # ---------- photos ----------

    def _photo_get(self, plant_id):
        try:
            with open(self.store.photo_path(plant_id), "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            return self._fail(404, "No photo for that plant")
        except Exception as exc:
            return self._fail(500, "Cannot read the photo: %s" % exc)

        self._own_cache = True
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        # Safe to cache hard: the client appends ?v=<version> and changes it
        # whenever the photo is replaced.
        self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _photo_put(self, plant_id):
        data = self._read_body(MAX_PHOTO)
        if data is None:
            return
        if not data.startswith(b"\xff\xd8\xff"):
            return self._fail(400, "Expected a JPEG")

        with _lock:
            try:
                self.store.save_photo(plant_id, data)
            except Exception as exc:
                return self._fail(500, "Cannot write the photo: %s" % exc)

        self._send_json(200, {"photo": plant_id + ".jpg", "bytes": len(data)})

    def _photo_delete(self, plant_id):
        with _lock:
            try:
                removed = self.store.delete_photo(plant_id)
            except Exception as exc:
                return self._fail(500, "Cannot remove the photo: %s" % exc)
        self._send_json(200, {"removed": removed})

    # ---------- plumbing ----------

    def _read_body(self, limit):
        """Returns the body, or None after having already sent an error."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._fail(400, "Bad Content-Length")
            return None
        if length <= 0:
            self._fail(400, "Empty body")
            return None
        if length > limit:
            self._fail(413, "Body too large (limit %d bytes)" % limit)
            return None
        return self.rfile.read(length)

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._own_cache = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _fail(self, code, message):
        # Anything left unread on the socket would desync the next keep-alive
        # request, so a failure part-way through a body has to close. A request
        # that never had a body has nothing to desync, and closing after one is
        # not free: the next request races the FIN onto the pooled connection
        # and loses often enough to show up as "no connection to the Pi" the
        # moment you correct a mistyped figure in the catalogue search.
        try:
            unread = int(self.headers.get("Content-Length") or 0) > 0
        except ValueError:
            unread = True          # unparseable: assume the worst and close
        self.close_connection = unread
        self._send_json(code, {"error": message})

    def end_headers(self):
        # Static assets: always revalidate, so an app update is picked up on the
        # next launch instead of being pinned by a stale iOS cache.
        if not self._own_cache:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Serve the Plants page and its JSON store.")
    parser.add_argument("--host", default="0.0.0.0", help="address to bind (default: all)")
    parser.add_argument("--port", type=int, default=8080, help="port to listen on (default: 8080)")
    parser.add_argument("--web", default=here, help="directory holding index.html")
    parser.add_argument("--data", default=None,
                        help="path to plants.json (default: <web>/data/plants.json)")
    parser.add_argument("--catalog", default=None,
                        help="path to plants.sqlite (default: alongside plants.json)")
    args = parser.parse_args()

    data = args.data or os.path.join(args.web, "data", "plants.json")
    if os.path.isdir(data):
        data = os.path.join(data, "plants.json")

    catalog = args.catalog or os.path.join(os.path.dirname(os.path.abspath(data)),
                                           "plants.sqlite")

    Handler.store = Store(data)
    Handler.catalog = Catalog(catalog)
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=args.web))

    print("plants: http://%s:%d  web=%s  data=%s" % (args.host, args.port, args.web, data), flush=True)
    print("plants: catalogue %s (%s)" %
          (catalog, "ready" if Handler.catalog.available() else "not installed"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("plants: stopping", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
