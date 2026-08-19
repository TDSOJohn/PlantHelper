#!/usr/bin/env python3
"""
Plants — a small LAN-only server for the plant database.

Serves the static page, one JSON endpoint and the plant photos:

    GET    /api/plants        ->  {"version": 1, "updatedAt": "...", "plants": [...]}
    PUT    /api/plants        <-  {"plants": [...]}
    PUT    /api/photo/<id>    <-  raw JPEG bytes (the browser resizes to 512x512)
    DELETE /api/photo/<id>
    GET    /photos/<id>.jpg

A PUT to /api/plants is *merged* with what is already on disk rather than
replacing it, so two phones that were both edited offline can sync in any order
without losing an edit. Writes are atomic and a snapshot is kept once a day,
because SD cards and power cuts do not mix.

Standard library only — nothing to install on the Pi beyond Python itself.
"""

import argparse
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_PATH = "/api/plants"
PHOTO_API = re.compile(r"^/api/photo/([A-Za-z0-9_-]{1,64})$")
PHOTO_FILE = re.compile(r"^/photos/([A-Za-z0-9_-]{1,64})\.jpg$")

MAX_BODY = 4 * 1024 * 1024        # a plant list will never come close
MAX_PHOTO = 2 * 1024 * 1024       # a 512x512 JPEG is ~50 kB
BACKUP_KEEP = 30                  # daily snapshots to retain
HIDDEN = ("/data", "/backups")    # never served as static files

_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def merge(current, incoming):
    """Union by id; the most recently updated copy of each plant wins.

    Ties go to `incoming`, and deletes are tombstones (a plant with a
    `deletedAt`), so a stale device cannot resurrect something you deleted.
    """
    out = {}
    for plant in list(current) + list(incoming):
        if not isinstance(plant, dict):
            continue
        pid = plant.get("id")
        if not isinstance(pid, str) or not pid:
            continue
        seen = out.get(pid)
        if seen is None or str(plant.get("updatedAt") or "") >= str(seen.get("updatedAt") or ""):
            out[pid] = plant
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
            return {"version": 1, "updatedAt": None, "plants": []}

        if isinstance(doc, list):          # tolerate a bare array
            doc = {"plants": doc}
        plants = doc.get("plants")
        return {
            "version": 1,
            "updatedAt": doc.get("updatedAt"),
            "plants": plants if isinstance(plants, list) else [],
        }

    def save(self, plants):
        doc = {"version": 1, "updatedAt": now_iso(), "plants": plants}
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


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"     # keep-alive: fewer round trips over Wi-Fi
    store = None
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

        with _lock:
            try:
                current = self.store.load()
                doc = self.store.save(merge(current["plants"], incoming))
            except Exception as exc:
                return self._fail(500, "Cannot write the data file: %s" % exc)

        self._send_json(200, doc)

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
        # Anything unread on the socket would desync the next keep-alive request.
        self.close_connection = True
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
    args = parser.parse_args()

    data = args.data or os.path.join(args.web, "data", "plants.json")
    if os.path.isdir(data):
        data = os.path.join(data, "plants.json")

    Handler.store = Store(data)
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=args.web))

    print("plants: http://%s:%d  web=%s  data=%s" % (args.host, args.port, args.web, data), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("plants: stopping", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
