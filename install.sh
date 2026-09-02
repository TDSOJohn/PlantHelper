#!/bin/sh
# Install Plants as a systemd service. Run on the Pi with sudo:
#
#     sudo ./install.sh
#
# Override any of these if you like:
#     APP_DIR=/opt/plants DATA_DIR=/var/lib/plants PORT=80 sudo -E ./install.sh
#
# Re-running it is safe: it updates the app, refreshes the reference catalogue
# if the repo carries one, and never touches your plant list.
set -eu

APP_DIR=${APP_DIR:-/opt/plants}
DATA_DIR=${DATA_DIR:-/var/lib/plants}
SERVICE_USER=${SERVICE_USER:-plants}
PORT=${PORT:-80}

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root: sudo ./install.sh" >&2
  exit 1
fi

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "creating user $SERVICE_USER"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "installing the app into $APP_DIR"
install -d -m 755 "$APP_DIR"
install -m 644 -t "$APP_DIR" \
  "$SRC/index.html" "$SRC/styles.css" "$SRC/app.js" \
  "$SRC/manifest.webmanifest" "$SRC/icon.svg" "$SRC/icon-180.png" "$SRC/icon-512.png" \
  "$SRC/README.md"
install -m 755 -t "$APP_DIR" "$SRC/server.py"

echo "preparing $DATA_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

# The reference catalogue. Two builds may be sitting in data/, and the fuller
# one wins: plants.full.sqlite is Wikipedia plus pfaf.org and does not travel
# in the repo, because pfaf.org grants no reuse licence — you copy it across by
# hand. plants.sqlite is the Wikipedia-only build, which does travel, so a
# clone that has never had a copy made to it still installs a working
# catalogue. Either is installed under the one name the server looks for.
#
# Safe to replace wholesale because it is derived: plants_db rebuilds it from
# the sources, and nothing in the app ever writes to it. plants.json is the
# opposite on every count and is never copied from the repo — the plant list on
# the Pi is the only copy that matters, and overwriting it with a developer's
# would be unrecoverable.
#
# Staged and renamed rather than written over. The server opens the file on
# every search, and one landing in the window where a plain copy has truncated
# it gets "Cannot read the catalogue" — about one request in 400 when measured,
# which is rare enough to be baffling rather than obviously self-inflicted.
for name in plants.full.sqlite plants.sqlite; do
  [ -f "$SRC/data/$name" ] || continue
  echo "installing the catalogue ($name) into $DATA_DIR"
  install -m 640 -o "$SERVICE_USER" -g "$SERVICE_USER" \
    "$SRC/data/$name" "$DATA_DIR/plants.sqlite.new"
  mv "$DATA_DIR/plants.sqlite.new" "$DATA_DIR/plants.sqlite"
  break
done

echo "installing the service"
sed -e "s|@APP_DIR@|$APP_DIR|g" \
    -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@PORT@|$PORT|g" \
    "$SRC/plants.service" > /etc/systemd/system/plants.service

systemctl daemon-reload
systemctl enable plants >/dev/null
systemctl restart plants

sleep 1
if systemctl is-active --quiet plants; then
  suffix=""
  [ "$PORT" = "80" ] || suffix=":$PORT"
  echo
  echo "Plants is running: http://$(hostname).local$suffix"
  echo "Logs:              journalctl -u plants -f"
else
  echo
  echo "The service failed to start. Recent log:" >&2
  journalctl -u plants -n 20 --no-pager >&2
  exit 1
fi
