#!/usr/bin/env python3
"""
Plants — a small LAN-only server for the plant database.

Serves the static page and one JSON endpoint:

    GET /api/plants  ->  {"version": 1, "updatedAt": "...", "plants": [...]}
    PUT /api/plants  <-  {"plants": [...]}

A PUT is *merged* with what is already on disk rather than replacing it, so two
phones that were both edited offline can sync in any order without losing an
edit. Writes are atomic and a snapshot is kept once a day, because SD cards and
power cuts do not mix.

Standard library only — nothing to install on the Pi beyond Python itself.
"""

import argparse
import json
import os
import shutil
import tempfile
import threading
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_PATH = "/api/plants"
MAX_BODY = 4 * 1024 * 1024        # a plant list will never come close
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
    """The plant list as a single JSON file."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.dir = os.path.dirname(self.path)
        self.backup_dir = os.path.join(self.dir, "backups")
        os.makedirs(self.dir, exist_ok=True)

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

        # Write to a temp file in the same directory, fsync, then rename over
        # the original: a power cut leaves either the old file or the new one,
        # never a half-written one.
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".plants-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

        dir_fd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

        return doc

    def _snapshot(self):
        """Keep one copy per day, pruned to the last BACKUP_KEEP days."""
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
    _json_response = False

    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map)
    extensions_map[".webmanifest"] = "application/manifest+json"

    # ---------- routing ----------

    def do_GET(self):
        self._json_response = False
        if self._path() == API_PATH:
            return self._api_get()
        if self._is_hidden():
            return self._fail(404, "Not found")
        return super().do_GET()

    def do_HEAD(self):
        self._json_response = False
        if self._path() == API_PATH:
            return self._fail(405, "Use GET")
        if self._is_hidden():
            return self._fail(404, "Not found")
        return super().do_HEAD()

    def do_PUT(self):
        self._json_response = False
        if self._path() != API_PATH:
            return self._fail(405, "Method not allowed")
        return self._api_put()

    do_POST = do_PUT

    def _path(self):
        return urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"

    def _is_hidden(self):
        path = self._path()
        return "/." in path or any(path == h or path.startswith(h + "/") for h in HIDDEN)

    # ---------- api ----------

    def _api_get(self):
        with _lock:
            try:
                doc = self.store.load()
            except Exception as exc:                       # corrupt file: fail loudly
                return self._fail(500, "Cannot read the data file: %s" % exc)
        self._send_json(200, doc)

    def _api_put(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._fail(400, "Bad Content-Length")
        if length <= 0:
            return self._fail(400, "Empty body")
        if length > MAX_BODY:
            return self._fail(413, "Body too large")

        raw = self.rfile.read(length)
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

    # ---------- plumbing ----------

    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._json_response = True
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
        if not self._json_response:
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
