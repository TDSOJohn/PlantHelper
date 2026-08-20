# Plants

A personal database of the plants I own, served from a Raspberry Pi on the home
network. A tab bar moves between **Today** (what needs water), **All plants**,
**Add** and **Settings**. Each plant has a name and a species, notes, a watering
schedule, a photo, the temperatures it likes, and a note of whether it lives
inside or outside.

No frameworks and no dependencies: a static page plus a ~250-line Python
standard-library server. Nothing to install on the Pi beyond what Raspberry Pi
OS already ships.

```
index.html  styles.css  app.js  icon*      the page
server.py                                  static files, /api/plants, photos
plants.service  install.sh                 run it under systemd
```

## Name and species

The **name** is whatever you actually call the plant — *Basil*, *the big one in
the kitchen*. It is the only required field, and it is what the lists show and
sort by. The **species** is the botanical name: optional, free text, and shown
on the plant's own page rather than in the lists, which are already carrying
the place and the watering status.

Keeping the two apart means a nickname never has to pretend to be a binomial,
and two plants of the same species can still be told apart at a glance. On the
species box autocorrect and word-capitalisation are turned off, because a
binomial capitalises only its genus and iOS is otherwise keen to turn
*deliciosa* into *delicious*.

Nothing validates the species against a list of real plants. An earlier attempt
at that — the World Flora Online backbone baked in as a lookup — was dropped:
90-odd thousand names is a lot of file to carry for autocomplete alone, when
the taxonomy carries no care information to go with it.

## Watering schedules

A plant can have one of two schedules, or none at all:

- **Every N days**, counted from the day you set it up, or from the last time
  you watered it if that is more recent.
- **Certain weekdays** — Mondays and Fridays, say.

Both are shown on the home screen under *Water today*, most overdue first, each
with a ✓ button to tick it off without opening the plant. A plant is off the
list for the rest of the day once it is watered, and an interval plant that was
missed keeps showing up, labelled `3 days late`, until it is dealt with.

Two things worth knowing:

- **A new "every N days" plant is not due the day you create it** — the clock
  starts then, so the first watering falls N days later. The form says
  *starting today* and the detail page shows the date, but if you want it in
  today's list straight away, set the interval and then let it come round, or
  use a weekday schedule instead.
- **Missing a weekday schedule does not carry over.** If a Monday plant is not
  watered on Monday, it is simply not due on Tuesday. That is what picking
  weekdays means; use an interval if you want lateness tracked.

The free-text watering note is still there, for the things a schedule cannot
express — *less in winter*, *let the soil dry out*.

Schedules are evaluated in **local calendar days**, not UTC instants, so the
list rolls over at your midnight rather than somewhere in the evening. The date
maths is checked against daylight-saving jumps in both directions.

## Inside or outside

Optional, and off by default: a plant is *Inside*, *Outside*, or simply not
marked. When it is set it appears first on the plant's own page and at the start
of its line in both lists — enough to split a watering round into the windowsills
and the balcony without having to open anything.

Nothing else keys off it: it does not filter the lists and does not affect
schedules. Plants added before it existed read as *Not set* until you say
otherwise, and can be left that way indefinitely.

## Temperature and humidity

Six optional numbers. Four temperatures in whole °C — the range the plant is
*happy* in, and the wider range it merely *survives* — and two humidities in
whole per cent. Fill in whichever you know and leave the rest blank; a plant
recorded only as surviving down to 5 °C is a perfectly good record.

The detail page reads each group back as one line, `18–27 °C · Survives 5 to
38 °C` and `40–60%`, collapsing to a bound where only one end of a range is
set: *Above 12 °C*, *Below 60%*, *Survives up to 38 °C*.

The one rule enforced is **order**. Coldest to warmest the temperatures are
`absMin`, `avgMin`, `avgMax`, `absMax`; humidity is `min` then `max`. Within a
group each figure must be at least the one before it. Blanks are skipped rather
than counted as zero, so filling in only the two comfortable temperatures
checks them against each other and nothing else, and the two groups are never
compared with one another. Saving stops with the offending box highlighted
rather than storing a range that reads backwards — and both groups are checked
on every attempt, so a complaint about a box you have since fixed does not
linger while you deal with the other one. Figures outside -60…60 °C or 0…100%
are clamped rather than refused.

Nothing else keys off them: they do not affect schedules, and they are kept off
the list lines, which already carry the place and the watering status. Plants
added before the fields existed read as *Not set*.

## Photos

One photo per plant, taken or picked with the normal iOS photo sheet.

The **browser** does the resizing: centre-cropped to 512x512 and encoded as JPEG
on a canvas before anything is sent, so the Pi never decodes a 4 MB phone photo
and needs no image library installed. EXIF rotation is honoured, so photos taken
sideways are not stored sideways. A finished photo is around 50 kB.

The file lives on the **server**, at `<data>/photos/<plant-id>.jpg`, not in
`plants.json`. A few dozen base64-encoded photos would blow past the browser's
~5 MB localStorage quota and be re-sent on every sync. The plant record carries
only `photo`, a version stamp that changes when the photo is replaced, which is
what lets the images be cached hard (a week) and still update instantly.

Photos are the one part of the app with **no offline path**: they go straight to
the server, and if it cannot be reached the app says so and changes nothing.
Everything else keeps working from the local cache.

Replacing a photo overwrites the same file — the name comes from the plant id,
so there is never an old one to clean up, and the write is atomic like every
other. Deleting a plant is handled twice over: the browser fires a `DELETE`,
and then every sync sweeps the photo of any plant carrying a `deletedAt`. The
sweep is the one that counts, because the browser's request is fire-and-forget
— a plant deleted while the Pi was unreachable, or from a phone that was
offline, would otherwise leave its JPEG behind with nothing pointing at it and
nothing to retry. Tombstones always arrive in the end, and a `deletedAt` is
final, so the file is unreferenced for good.

Ids reaching the sweep come out of the request body rather than a URL, so they
are checked against the same character class the photo routes use before being
turned into a filename; `../..` in an id is stored as an ordinary string and
never touches the disk.

One gap is left deliberately. If **Remove photo** fails to reach the server,
the record forgets the photo but the file stays. Sweeping on *the record has no
`photo` key* would catch it, but could race a photo that has been uploaded
seconds before its record syncs, and deleting a photo someone just took is
worse than leaving 50 kB on a memory card.

## How it works

The Pi serves both the page and its data, so everything is same-origin: no
tokens, no CORS, no cloud account.

    GET    /api/plants      ->  {"version": 1, "updatedAt": "...", "plants": [...]}
    PUT    /api/plants      <-  {"plants": [...]}
    PUT    /api/photo/<id>  <-  raw JPEG bytes
    DELETE /api/photo/<id>
    GET    /photos/<id>.jpg

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
  back in. Photos are not included — they are files, not JSON.
- Copy the whole data directory off the Pi periodically, photos and all:
  `rsync -a plants.local:/var/lib/plants/ ~/backups/plants/`

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
      "name": "The big one in the kitchen",
      "species": "Monstera deliciosa",
      "place": "inside",
      "temps": { "absMin": 5, "avgMin": 18, "avgMax": 27, "absMax": 38 },
      "humidity": { "min": 40, "max": 60 },
      "schedule": { "type": "interval", "days": 7, "start": "2026-08-19" },
      "lastWatered": "2026-08-19",
      "photo": "2026-08-19T10:04:00.000Z",
      "water": "Less in winter",
      "notes": "Bright indirect light. Repotted March 2026.",
      "createdAt": "2026-08-19T10:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    },
    {
      "id": "k9j8h7-a1b2c3",
      "name": "Basil",
      "species": "Ocimum basilicum",
      "place": "outside",
      "temps": { "avgMin": 15 },
      "humidity": null,
      "schedule": { "type": "weekly", "weekdays": [1, 5] },
      "water": "",
      "notes": "Kitchen windowsill.",
      "createdAt": "2026-08-19T10:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    }
  ]
}
```

`schedule` is `null` or absent when a plant has none, `weekdays` runs 0 = Sunday
to 6 = Saturday, and `lastWatered` is a local date. `photo` is absent when there
is none; when present its value is only a version stamp — the image itself is
`<data>/photos/<id>.jpg`. `place` is `"inside"`, `"outside"`, or empty/absent
when it was never set. `species` is free text, empty or absent when it was
never filled in. `temps` and `humidity` are each `null` or absent until
at least one of their figures is filled in, and then carry only the ones that
were — as in Basil above, which has a comfortable low and nothing else.
Plants saved before a field existed simply have no key for it — an older
plant has no `schedule` and never appears in *Water today*, and no `place` and
reads as *Not set*. Nothing to migrate either way.

A deleted plant keeps its entry with a `deletedAt` timestamp, so that a phone
that was offline during the delete cannot bring it back.

## Local development

```sh
python3 server.py --port 8080 --data ./data/plants.json
```

then open <http://localhost:8080>. There is nothing to build.
