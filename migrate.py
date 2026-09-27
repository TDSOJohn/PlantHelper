#!/usr/bin/env python3
"""
Bring plants.json up to the shape the current app expects.

    python3 migrate.py /var/lib/plants/plants.json

Run by `sudo ./install.sh --migrate`, which stops the service first so that
nothing writes the file underneath it. Each migration below looks at the data
rather than at a version number and changes only what is still in the old
shape, so running this twice, or on a file that never needed it, changes
nothing.

A changed record gets a fresh `updatedAt`. Phones merge by that stamp, so a
phone still holding the old shape takes the new one on its next sync instead
of pushing the old one back.

The file is copied to backups/ before it is rewritten, under a name the
server's daily pruning does not touch, and replaced atomically with the same
owner and mode it had.

Standard library only, like the server.
"""

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone


def now_iso():
    """As the browser's toISOString writes it, milliseconds and all: both ends
    compare `updatedAt` as a string, so the migrated stamp has to be in the
    same format as the ones it is compared with."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def potted_count(doc, now):
    """Sowings count what they potted up; plants stop linking back to them.

    A plant used to carry the `sowingId` of the sowing it was potted up from,
    and the sowing worked out how many it had potted up by counting those.
    Now the sowing stores `potted` and the plants carry nothing. The count is
    taken from every plant with the id, deleted ones included: a plant given
    away was still potted up.
    """
    plants = doc["plants"]
    changed = 0

    for sowing in doc["sowings"]:
        if not isinstance(sowing, dict) or "potted" in sowing:
            continue
        sowing["potted"] = sum(1 for p in plants
                               if isinstance(p, dict) and p.get("sowingId") == sowing.get("id"))
        sowing["updatedAt"] = now
        changed += 1

    for plant in plants:
        if isinstance(plant, dict) and "sowingId" in plant:
            del plant["sowingId"]
            plant["updatedAt"] = now
            changed += 1

    return changed


# In the order they were written. A new one goes at the end.
MIGRATIONS = [potted_count]


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: migrate.py <path to plants.json>")
    path = os.path.abspath(sys.argv[1])

    if not os.path.exists(path):
        print("migrate: no %s yet, nothing to do" % path)
        return

    with open(path, "r", encoding="utf-8") as handle:
        doc = json.load(handle)
    if isinstance(doc, list):              # the server tolerates a bare array too
        doc = {"plants": doc}
    for key in ("plants", "species", "sowings"):
        if not isinstance(doc.get(key), list):
            doc[key] = []

    now = now_iso()
    total = 0
    for migration in MIGRATIONS:
        changed = migration(doc, now)
        print("migrate: %s: %d record%s changed"
              % (migration.__name__, changed, "" if changed == 1 else "s"))
        total += changed

    if not total:
        print("migrate: already up to date")
        return

    directory = os.path.dirname(path)
    backup_dir = os.path.join(directory, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, "pre-migrate-%s.json.bak"
                          % datetime.now().strftime("%Y-%m-%d-%H%M%S"))
    shutil.copy2(path, backup)
    print("migrate: the old file is at %s" % backup)

    doc["updatedAt"] = now
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"

    # As the server writes it: temp file, fsync, rename. The owner is put back
    # because this runs as root and the service, which has to keep writing the
    # file, does not.
    stat = os.stat(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(text.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, stat.st_mode & 0o7777)
        if os.geteuid() == 0:
            os.chown(tmp, stat.st_uid, stat.st_gid)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    print("migrate: %s updated" % path)


if __name__ == "__main__":
    main()
