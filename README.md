# Plants

A personal database of the plants I own, served from a Raspberry Pi on the home
network. Add a plant with a name, notes and a watering schedule; browse the
list; open one to read the details.

No frameworks and no dependencies: a static page plus a ~250-line Python
standard-library server. Nothing to install on the Pi beyond what Raspberry Pi
OS already ships.

```
index.html  styles.css  app.js  icon*      the page
server.py                                  static files + /api/plants
plants.service  install.sh                 run it under systemd
```

## How it works

The Pi serves both the page and its data, so everything is same-origin: no
tokens, no CORS, no cloud account.

    GET /api/plants  ->  {"version": 1, "updatedAt": "...", "plants": [...]}
    PUT /api/plants  <-  {"plants": [...]}

A `PUT` is **merged** with what is already on disk rather than replacing it —
union by plant id, most recently updated copy wins, deletes are tombstones. So
two phones edited while apart both keep their changes, in whatever order they
sync, and there is no revision number for the client to juggle.

The browser keeps a copy in `localStorage`. That is only a cache: it lets the
app keep working while the Pi reboots or Wi-Fi drops, and any edit made
meanwhile is flagged and pushed on the next sync (on launch, when the tab
becomes visible, or when the network returns).

## Deploying on a headless Pi Zero 2 W

### 1. Flash the card

Use **Raspberry Pi Imager**, pick **Raspberry Pi OS Lite (64-bit)**, then open
the settings (gear icon) *before* writing — this is the whole headless story:

- **Hostname:** `plants` → the Pi answers to `plants.local`
- **Enable SSH**, with your public key
- **Wi-Fi** SSID, password and country (the Zero 2 W is 2.4 GHz only)
- Username, locale, timezone

Boot the Pi and `ssh <user>@plants.local`. iOS, macOS and Linux all resolve
`.local` names over mDNS with nothing to configure; Windows needs Bonjour.

### 2. Install

```sh
git clone <this repo> plants && cd plants
sudo ./install.sh
```

That copies the app to `/opt/plants`, creates a system user, puts the data in
`/var/lib/plants`, and enables the service. Override the defaults if you like:

```sh
APP_DIR=/opt/plants DATA_DIR=/var/lib/plants PORT=80 sudo -E ./install.sh
```

Re-running it updates the app and restarts the service; it never touches the
data directory.

### 3. Open it

<http://plants.local> on the phone → Share → **Add to Home Screen**. It gets
its own icon and launches without Safari's chrome.

Port 80 is bound without running as root: the unit grants
`CAP_NET_BIND_SERVICE` to an unprivileged user. That is what keeps the URL free
of a `:8080` suffix.

### 4. Turn off Wi-Fi power saving

The Zero 2 W parks its radio aggressively, which shows up as a two-to-three
second delay on the first request after an idle period:

```sh
sudo iw dev wlan0 set power_save off                    # now
echo -e '[connection]\nwifi.powersave = 2' | \
  sudo tee /etc/NetworkManager/conf.d/wifi-powersave.conf   # and after reboots
```

(On an older Pi OS release that still uses `dhcpcd` rather than NetworkManager,
put the `iw` command in `/etc/rc.local` instead.)

### Everyday commands

```sh
systemctl status plants
journalctl -u plants -f
sudo systemctl restart plants
```

## Why not `php -S`

It would work, but `php -S` is documented as a development server: single
process unless you set `PHP_CLI_SERVER_WORKERS`, no supervision, and nothing
restarts it after a reboot or a crash. You would end up wrapping it in systemd
anyway — and if you wanted it done properly, `nginx` + `php-fpm`, which is three
moving parts and an `apt install` on a 512 MB machine.

Python is already on Raspberry Pi OS, `http.server` is stdlib, and one systemd
unit covers the supervision, the reboot and the port-80 permission. Same result,
less to install and less to keep updated.

The same honesty applies in the other direction: `http.server` is also not a
hardened production server. For a single-user app on a trusted LAN with no
untrusted input that is fine, and it is what the standard library is for. If
this ever faced the open internet, it should sit behind nginx.

## What LAN-only means

Away from home the app does not work at all — not even read-only. The page
itself comes from the Pi, so if `plants.local` is unreachable there is nothing
to load; the `localStorage` cache only helps a tab that is already open.

Serving the page from somewhere public instead does not help: an HTTPS page is
not allowed to call `http://plants.local` (mixed content), and a service worker
for real offline use needs a secure context, which a plain `.local` name cannot
be.

If you ever want it outside the house, the least-effort route is
[Tailscale](https://tailscale.com) on the Pi and the phone — your devices reach
each other from anywhere, and `tailscale serve` provides a real HTTPS
certificate, which as a bonus makes a service worker (and true offline use)
possible. Nothing else about the app would need to change.

## Security

There is no authentication. Anyone on your Wi-Fi — including guests — can read
and edit the plant list. For this data that seems like the right trade; if not,
put the Pi on a separate SSID or add a check to `server.py`.

## Backups

Three layers, in increasing order of effort:

- The server keeps a dated snapshot in `/var/lib/plants/backups/` on the first
  write of each day, pruned to the last 30.
- Settings → **Export JSON** saves the whole list; **Import JSON** merges one
  back in.
- Copy the file off the Pi periodically:
  `scp plants.local:/var/lib/plants/plants.json ~/backups/`

Writes are atomic — temp file, `fsync`, rename — so a power cut leaves either
the old file or the new one, never a truncated one. That matters more than
usual on an SD card. Prefer `sudo shutdown -h now` over pulling the plug.

## Data format

```json
{
  "version": 1,
  "updatedAt": "2026-08-19T10:00:00Z",
  "plants": [
    {
      "id": "m1a2b3-x9y8z7",
      "name": "Monstera deliciosa",
      "water": "Every 7 days, less in winter",
      "notes": "Bright indirect light. Repotted March 2026.",
      "createdAt": "2026-08-19T10:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    }
  ]
}
```

A deleted plant keeps its entry with a `deletedAt` timestamp, so that a phone
that was offline during the delete cannot bring it back.

## Local development

```sh
python3 server.py --port 8080 --data ./data/plants.json
```

then open <http://localhost:8080>. There is nothing to build.
