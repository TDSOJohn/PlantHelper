# Plants

A personal database of the plants I own, served from a Raspberry Pi on the home
network. A tab bar moves between **Today** (what needs water), **All plants**,
**Species**, **Seeds**, **Catalogue** and **Settings**. The arrow at the top
left shows up only on the pages that bar cannot reach — a plant, a species, a
sowing, a catalogue entry, and the forms that add or edit them — because
everywhere else is already one tap away, and an arrow that unwinds a trail you
did not know you were leaving only raises the question of where it goes.

A list you can add to opens with the button that adds to it: **Add a plant** at
the top of **All plants**, **Add a species** at the top of **Species**, **Sow
seeds** at the top of **Seeds**. Adding a plant used to be a tab of its own,
which made it the one item in the bar that *did* something rather than going
somewhere — the one you could press by accident and have to back out of. Each
button now sits above the list it changes, and the three pages that own a kind
of record are the three pages that make one.

The bar is for going places, and it got the [catalogue](#catalogue) in exchange.
That was a button at the foot of **Species**, which is a strange place for it:
5,065 entries you can read without owning a plant are not a footnote to the
handful of species you keep, and reaching them meant opening a list first. It
is a tab now, and **Add a species** has the top of that page to itself.

Both moves fell out of the same rule rather than being coded. The arrow shows
on a page the bar cannot reach, so the new-plant form gained one the moment it
stopped being a tab and the catalogue search lost one the moment it became one.
All three *new* forms behave the same way now, where the plant one used to be
the odd one out.

Each plant has a name and a species, notes, a watering schedule, a photo, the
temperatures it likes, and a note of whether it lives inside or outside. Figures that are true of a whole
kind of plant can live on a **species** record instead, and be shared by every
plant of that kind. Seeds are tracked before they are plants at all: a
[sowing](#seeds) records how many went in and how many came up, and keeps the
running score for each species.

No frameworks and no dependencies: a static page plus a ~250-line Python
standard-library server. Nothing to install on the Pi beyond what Raspberry Pi
OS already ships.

```
index.html  styles.css  icon*   the page
core.js  sync.js  wiring.js     state and model, server sync, boot
views.js  species.js  seeds.js  the screens
catalog.js                      the reference catalogue screens
server.py                       static files, /api/plants, photos
plants.service  install.sh      run it under systemd
data/plants.sqlite              the reference catalogue
data/plants.full.sqlite         the same, with pfaf.org — not in git
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

Typing a name that matches a **species record** links the plant to it, which is
what the next section is about.

## Species

A species record holds what is true of every plant of that kind — the
temperatures, the humidity, the soil pH, the light it wants, how big it gets,
how often it wants water, and notes on the kind — and nothing that belongs to
an individual. No watering notes, no photo, and no record of when anything was
last watered.

Notes sit on both, because they are two different notes: the species holds what
is true of the kind, a plant what is true of yours.

A plant follows one by having exactly that name in its own species box; the
match ignores case and surrounding spaces. There is no picker to keep in sync
and no migration: a plant whose species is just typed text stays exactly as it
was until a record by that name exists.

### Known as

One box on a species is not a fact about the plant at all. **Known as** is what
*you* call the kind — *Swiss cheese plant*, *basilico* — and it starts empty
and stays empty until you type in it. Nothing fills it in, not even the
catalogue, which has a common name for most entries and would have been an
obvious thing to copy across. It is left alone because a name you did not
choose is not the name you would have recognised, and the field's whole job is
recognition.

Nothing matches on it either. A plant still joins a species by the botanical
name and nothing else, so filling this in, changing it or clearing it can never
move a plant from one species to another. That is what keeps it safe to treat
as a scribble.

It shows in two places: under the binomial on the species' own page, and at the
front of its row in the species list, which is the list it is there to make
readable. A species you have not filled it in for looks exactly as it did.

### The species page

A row in the species list, and the **open** link beside a plant's species,
land on the species itself rather than on the form for it: the same facts a
catalogue entry shows, laid out the same way, then whatever the catalogue had
to say about the kind, the notes, and the plants of your own that follow it.
**Edit species** is the way into the form, and on a species that came from the
catalogue **Open the catalogue entry** goes back to the article's prose.

A species is read far more often than it is changed — every time you wonder
what a plant of yours is supposed to want — and opening straight into a form
made every one of those a chance to change something by accident.

### Filling one in from the catalogue

Nine species in ten are already in the [catalogue](#catalogue), so you should
not have to type one out. Open the entry and press **Add as a species**: the
form opens with every figure the entry records already in its boxes, and you
press Save.

If you already keep a species that entry would describe — one linked to it
before, or simply one going by the same name — the button says **Fill in
*that*** instead, and it is that record the form opens on. Typing a species by
hand and finding it in the catalogue afterwards is the case this is really for.

What comes across: the four condition groups, the height, the notes, and the
three marks with the *Uses* paragraph behind them. What does not: the watering
schedule, because how often you water something is not a fact an encyclopedia
has an opinion on. The name and the notes are filled only where you left them
empty; the figures are written over. Nothing is saved until you press Save, so
a fill you did not want is one Cancel away.

The figures are **copied, not linked**. A phone holds your plants offline and
would otherwise have nothing to show for a species the moment it is away from
the Pi — and re-mining a newer dump must never silently change the care figures
of a plant you own. What the record keeps of the entry is its `catalogId`, so
the form can offer **Open the entry** to read the article's prose again, and
**Fill in again** to take a newer dump's figures deliberately.

Wikipedia describes light four ways where a species knows two, so importing one
of the other two has to choose: partial sun is still sun, and shade is the
absence of it, which is what indirect light amounts to indoors.

### What is inherited, and what wins

Anywhere a plant leaves a group **empty**, its species' figure applies. Anything
the plant fills in wins, field group by field group — so a species can set the
temperature while one particular plant on a cold windowsill sets its own. On the
plant's page, a value that came from the species is labelled *inherited*, so a
number you did not type is never mistaken for one you did.

Height is the one that only ever goes one way. How big a kind gets is a fact
about the kind, so a plant has no height boxes of its own; its page shows the
species' figure or *Not set*.

On the forms a box is in one of three states, styled apart because two of them
are grey and would otherwise read as figures somebody had entered:

| | |
|---|---|
| **filled in** | upright, a little heavier, firmer border |
| **empty** | a dim italic example of the sort of figure that belongs there |
| **inheriting** | the figure the linked species actually supplies — accent-coloured, dashed border: grey enough to read as untyped, coloured enough to read as real |

The third appears only on a plant that follows a species, and only for figures
that species genuinely gives; being linked is not enough. Typing turns the box
into an ordinary filled one, and emptying it brings the inherited figure
straight back.

This works because *unset* was already how those fields read. Every plant that
existed before species did inherits nothing and behaves exactly as it always
has, and there is nothing to migrate.

### Schedules are the exception worth reading

A species supplies the **shape** of a watering schedule — every 7 days, or
Mondays and Fridays — but never the anchor. When the clock started is a fact
about your plant, not about the kind of plant it is, so an inherited interval
counts from that plant's last watering, falling back to the day it was added.

The practical consequence: linking a plant you added months ago to an
*every 7 days* species puts it on today's list immediately, rather than
pretending it was watered just now. One tap of ✓ settles it for good.

### Renaming and deleting

Plants link by id but remember the name they were typed with, so **renaming** a
species rewrites that text on every plant following it — otherwise the next edit
of one of those plants would find no species by that name and quietly unlink it.
Two species cannot share a name, for the same reason.

**Deleting** a species asks first, and says how many plants follow it. Those
plants keep every figure they had set themselves and lose only the ones they
were borrowing. Nothing happens to the catalogue entry it was filled from —
the app never writes to that file. The species itself becomes a tombstone, exactly like a deleted
plant.

### Why this is not a database

The obvious question is whether two related entities should mean SQLite —
which is in the Python standard library, so it would cost no new dependency.
It was left alone deliberately. The browser has to hold the whole dataset
anyway to keep working while the Pi reboots, so the wire format stays JSON
regardless and SQLite would only change what sits behind the API. At this size
there is no query to speed up, and the sync would get harder rather than
easier: two tables to merge instead of one list, and foreign keys that would
actively fight the design. A phone can quite legitimately create a plant
referencing a species another phone has not seen yet. That dangling reference
is a normal intermediate state, and the app treats it as one — the plant simply
falls back to its own figures until the species arrives.

There *is* a SQLite file on the Pi, and it is the exception that shows the
rule: the [catalogue](#catalogue) below is 5,065 rows nobody edits, rebuilt
from scratch whenever the sources behind it are re-mined, and never syncs
anywhere.
Every argument above turns on your plants being small, precious and offline.
None of the three is true of an encyclopedia.

## Catalogue

5,065 species built by [../plants_db](../plants_db) — the four condition groups
this app uses, plus a height and three yes-or-nothing marks that only make
sense on a catalogue. The **Catalogue** tab searches it.

Two sources are behind those rows. Every one of them began as an English
Wikipedia article; **1,132** have since been filled out from
[pfaf.org](https://pfaf.org), a plant-uses database that states soil, shade and
hardiness outright where an encyclopedia had to be mined for them. It shows in
the coverage — soil pH went from 235 rows to **1,278**, the kind of light from
1,224 to **2,025**, a minimum temperature from 789 to **1,649** — and it is why
the section below has two labels to distrust rather than one. An entry says
which sources it came from at the foot of its page.

It is the one part of the app that needs the Pi. Your plants are held in the
browser and work offline; an encyclopedia has no business in `localStorage`, so
the catalogue is queried on the server and the view says so plainly when it
cannot be reached.

### Two catalogues

The file comes in two builds, and which one you have is a licensing question
rather than a technical one:

| | | |
|---|---|---|
| `data/plants.sqlite` | 4.4 MB | Wikipedia only. **In the repo.** |
| `data/plants.full.sqlite` | 34.5 MB | Wikipedia + pfaf.org. **Not in the repo**, and in `.gitignore`. |

pfaf.org's pages carry `© Plants For A Future` and no reuse grant anyone can
find — the footer's link to a terms page is commented out in the HTML, so there
is not even a page to read. PFAF is a registered UK charity partly funded by
selling this same data as books and PDFs. Seeding a personal `plants.local`
from it is one thing; pushing a dump of it to GitHub is another, and not one
to do on a guess. So the full build stays off the public repo until somebody
has asked them.

Keeping the Wikipedia-only build in git rather than deleting it is what makes
that cheap: everything in it came from Wikipedia, which is CC BY-SA and says
so, and a clone with no catalogue copied to it still installs a working one.
`git checkout data/plants.sqlite` is the way back to it if the full build ever
has to go away in a hurry.

**Both builds carry the same columns.** The Wikipedia-only one leaves the five
pfaf.org added — `source`, the three 0–5 ratings, and `ph_from_bands` — empty
rather than omitting them, so there is one shape for `server.py` to read and no
build to special-case. What it does not carry is the `pfaf` table itself, which
holds the crawl in full and which the app never queries.

`server.py` and `install.sh` both take the full build where it is there and
fall back to the other, so nothing has to be configured either way. The startup
line says which one you got:

```
plants: catalogue /home/…/data/plants.full.sqlite (ready)
```

### Copying the full build across

It does not travel in the repo, so it is copied by hand — once per rebuild,
which is a few times a year. Into the Pi's clone, not into `/var/lib`, so that
`install.sh` still stages and restarts it properly:

```sh
# on the machine that built it: one copy for local development,
cp ../plants_db/plants.sqlite data/plants.full.sqlite
# and one for the Pi, into its clone
scp data/plants.full.sqlite plants.local:plants/data/plants.full.sqlite

# then on the Pi, as usual
cd plants && sudo ./install.sh
```

The `scp` on its own is the whole update where you do not run the app locally,
which is what [step 2](#2-install) shows.

It is ignored by git at both ends, so a `git pull` on the Pi leaves it alone
and `git status` stays clean. A pull cannot undo the copy either: what it
updates is the tracked `data/plants.sqlite`, which is a different file, and the
installer takes the one you copied over it regardless.

30 MB of the 34.5 is the `pfaf` table — the whole crawl, kept for provenance
and never read by the app. If the transfer over the Pi's Wi-Fi ever gets
tiresome, `DROP TABLE pfaf; VACUUM;` takes the copy to 4.6 MB and the app
cannot tell the difference.

### What you can search by

| | |
|---|---|
| **name** | any title or binomial containing what you type; an exact name sorts first |
| **survives down to** | entries whose recorded minimum is at or below that temperature |
| **soil pH** | entries whose recorded range covers that figure |
| **no taller than** | entries whose recorded height stops at or below that many centimetres |
| **light** | direct sun, indirect light, partial sun, or shade |
| **edible · other uses · aquatic** | entries the article marks as such |

The three figures deliberately mean three different things, because the data
does.

**Temperature** is asked as a floor: 1,649 entries record how cold a plant
takes and **63** record how hot, so asking it as a range makes "survives 45 °C"
match 1,596 of them — every plant whose ceiling nobody happened to write down.
That is a count of what the sources are missing, dressed up as an answer. pfaf
widened that gap rather than closing it: hardiness is exactly the end a plant
database states, and the other end still nobody does.

**pH** is asked as a range, because 1,237 of the 1,278 entries that record one
record both ends — a share that went up with pfaf, whose soil bands always give
two ends because that is what a band is.

**Height** is asked as a ceiling: the tallest figure recorded, which is the top
of the range where the article gave one and the single figure otherwise —
"growing to 2 m tall" is stored as a minimum with no maximum. Here nothing is
missing. 1,325 entries give a range, 1,354 a single figure and none a maximum
alone, so unlike temperature this one *could* have been a range. It is not,
because the question a windowsill asks is **what stays under 60 cm**, not what
is between two heights.

The three marks are yes-or-nothing rather than yes-or-no. They are set from
what a source commits to, so a 0 means nobody wrote it down — which is why an
unticked box asks nothing at all rather than asking for the plants that are
*not* edible. 1,507 entries are marked edible, 1,597 for some other use
(medicine, oil, dye, fibre — not timber or "ornamental", which are true of most
of the table and so separate none of it), and 121 as aquatic. They combine:
edible **and** aquatic is 30 rows, and one of them is a water chestnut.

pfaf's three **0–5 ratings** are shown on an entry but are not a filter. They
are on 1,132 rows — a fifth of the table — and a filter that silently ignores
the other four fifths is the same trap the temperature range would have been.
They also mean something the marks do not: a rating has a real zero, somebody
having looked and found no use of that kind, so a 0 is printed rather than
dropped.

There is no humidity or hours-of-light filter: 22 and 36 entries record them.
Neither moved with pfaf, which does not carry either. Both are implemented on
the server, so adding one is a line of HTML if that ever changes.

An entry that records nothing matches nothing — a search cannot honestly return
"we don't know" as a yes. Most entries record nothing, so when a filter finds
little the view says how much of the catalogue could have answered at all.

### Reading the results with the right suspicion

This is a **seed**, not a care sheet. Of the 5,065 entries, 3,337 carry a
figure of some kind, 2,098 carry at least one mark, 3,079 carry prose worth
keeping — and 1,010 carry none of the three and are names only.

Two labels on the entry page are there to be distrusted, and they are the same
kind of thing twice: an honest number standing in for a coarser statement.

**from a zone** means the minimum was read off a hardiness zone rather than a
sentence somebody wrote. 1,323 entries have one and they dominate any cold
search — *Angelica glauca* comes out surviving −34.4 °C from zone 4–7 while its
own prose says it is happy at 10–15 °C.

**from soil bands** is the new one, and it is why the pH column filled up.
pfaf states soil as named bands rather than as numbers, so a pH there is the
edges of whichever bands the page listed: 6.0–8.5 is "mildly acid, neutral and
basic" and not a figure anyone put a meter in the ground for. 1,043 of the
1,278 entries carrying a pH carry one of these. It is a useful thing to sort
on and a poor thing to quote, and the tell is how few distinct values there
are: **846 of the 1,043 read 6.0–8.5**, which is pfaf's way of saying it is not
fussy. The 235 that are unlabelled are the ones an editor
wrote out, and every entry below pH 5 is among them — rhododendron, kalmia,
blueberry — because a vocabulary that bottoms out at *mildly acid* cannot
produce a genuinely acid-loving plant.

The **Uses** paragraph is not always a recipe. 23 entries carry one with
neither mark set, because what the source had to say was a warning — peace
lily, sago palm and winter aconite are all in there — and those are shown
anyway: a houseplant app has more use for *all parts of the plant are
poisonous* than for silence. The reverse happens too: 508 entries carry a mark
with no sentence worth quoting, and show the mark alone.

**Lead** is shown exactly as stored, unedited. That is deliberate: this is a
view onto the file, so anything wrong with the file should be visible here
rather than tidied up on the way past. (Earlier builds leaked taxobox tails —
`| image = … | genus = …` — into about a third of the leads. `plants_db` fixed
that at the source, which is where such a fix belongs.)

Nothing is copied into your own records behind your back, and the app never
writes to the file. **Add as a species** on an entry is the one road out of the
catalogue and into your own records, and it copies the figures rather than
linking to them, so that re-mining a newer dump can never silently change the
care figures of a plant you own. See
[filling one in from the catalogue](#filling-one-in-from-the-catalogue).

## Seeds

A **sowing** is a batch: so many seeds of one kind, into one tray, on one day.
It is deliberately not a plant. A plant is a thing you water; a sowing is a
small experiment whose result arrives a few seeds at a time over a fortnight,
and which may produce six plants, or one, or none.

So a sowing does not have a status. It has counts:

| | |
|---|---|
| **Sowed** | how many seeds went in, and the day they did |
| **Up in about** | what the packet promises, in days — optional |
| **Seedlings** | how many have appeared and are still in the tray |
| **Died** | how many rotted, or simply never came |

*Still trying* is what is left over, and the sowing is finished when it reaches
zero. Nothing is ever recorded for the batch as a whole, which is the only way
*four of the twelve came up* can be written down honestly. A single status
would force that same tray to be filed as either a success or a failure, and
the percentages further down would then be counting trays rather than seeds.

### Recording what happened

Both numbers are boxes on the sowing's own page, typed straight into the card
that shows them. Going out to the tray and coming back with *four up, three
gone* is one thought, not a sequence of decisions, and a box takes it in either
direction: a miscount is corrected by typing the right number over it, and a
sowing that has been given up on can be reopened the same way. Nothing is
recorded for the batch as a whole, so the tray is never filed as a success or
a failure — only counted.

The one button left is **Pot up as plants**, because it does not move a tally,
it makes things. The seedlings become ordinary plants, one each, already
following the sowing's species and so inheriting its conditions and its
watering schedule. They are numbered (*Ocimum basilicum 1*, *2*, *3*) when the
sowing has produced more than one, and each keeps a link back to the sowing it
came from. Rename them as you like afterwards.

Potting up takes from the seedlings box first — those came up once and must not
be counted twice — and only what is left over from the seeds still under the
soil. Plants standing are shown beside the box rather than in it (*4* · *+ 2
potted up*), since typing a zero over a plant cannot be what you meant: the
plant is out there, in a pot, being watered.

Neither box will take more than is actually left in the tray. Editing the batch
size later is allowed, but it cannot be set below what has already been
accounted for — that would make the percentages lie.

### When to go and look

Give a sowing a germination time and it appears on the home screen under
**Seeds due** once that day arrives, in its own group under the plants to
water, and stays there — `4 days late` — until every seed is accounted for.
Looking to see whether anything is through is a different errand from watering,
and there is nothing to tick off without looking first, so the group has no ✓
buttons.

The group keeps the same shape as the watering one above it, down to the line
saying *Nothing due to come up today* — a day with nothing to look at is worth
being told about, and a group that vanished on the quiet days would leave you
wondering whether it had checked. It appears once anything has been sown, and
not before.

Leave the days empty and the sowing simply never turns up there. On a new
sowing the box is filled in from the last sowing of the same thing, since how
long a seed takes is a fact about the seed.

### How they did

The **Seeds** tab ends with one block per species: a bar in three parts and the
three percentages under it, *per seed rather than per batch*, pooled across
every sowing of that kind. The same block appears on the species' own page
under *From seed*. With more than one species there is an *All seeds* total
above the rest.

Sowings group by species record where there is one and by the name that was
typed where there is not, so a tray sown before you had the record joins its
own species once you add one — no editing required. A sowing keeps its name
either way.

Deleting a sowing keeps the plants it produced.

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

## Conditions

Four groups of optional figures, on a plant or on its species:

| | |
|---|---|
| **Temperature** | four in whole °C — the range it is *happy* in, and the wider one it merely *survives* |
| **Humidity** | two, in whole per cent |
| **Soil pH** | two, on the 0–14 scale, kept to one decimal place |
| **Light** | roughly how many hours a day, and whether that light is direct or indirect |

Fill in whichever you know and leave the rest blank; a plant recorded only as
surviving down to 5 °C is a perfectly good record.

The detail page reads each group back on one line — `18–27 °C · Survives 5 to
38 °C`, `40–60%`, `5.5–6.5`, `6 hours of indirect light` — collapsing to a
bound where only one end of a range is set: *Above 12 °C*, *Below 60%*,
*Survives up to 38 °C*. Either half of the light stands alone too: *Direct
light* with no hours, or *6 hours of light* with no flag.

**pH is the one kept to a decimal**, because the difference between 6 and 6.5
is the difference between a happy hydrangea and a chlorotic one. Everything
else rounds to whole numbers, where a decimal would be false precision.

Type `6,5` or `6.5` as you prefer — the pH boxes take either. They are the only
plain-text fields on the forms, and that is why: an `<input type="number">`
accepts a full stop and nothing else, and when it cannot parse its own contents
it reports an empty string rather than the text. On an iOS keypad set to a
comma locale, a pH typed with one therefore vanished on save without a word.
Since a text box can hold anything at all, something that is not a number stops
the save and says so, rather than being quietly dropped.

The one rule enforced is **order**. Coldest to warmest the temperatures are
`absMin`, `avgMin`, `avgMax`, `absMax`; humidity and pH are `min` then `max`.
Within a group each figure must be at least the one before it. Blanks are skipped rather
than counted as zero, so filling in only the two comfortable temperatures
checks them against each other and nothing else, and the two groups are never
compared with one another. Saving stops with the offending box highlighted
rather than storing a range that reads backwards — and both groups are checked
on every attempt, so a complaint about a box you have since fixed does not
linger while you deal with the other one. Figures outside their scale —
-60…60 °C, 0…100%, pH 0…14, 0…24 hours — are clamped rather than refused.

Nothing else keys off them: they do not affect schedules, and they are kept off
the plant list lines, which already carry the place and the watering status —
though a species row summarises all of them, since that is the whole point of a
species. Plants added before any of these existed read as *Not set*.

The short facts — species, place, all four groups and the schedule — share a
single card on the plant's page rather than getting a bordered block each.
Seven stacked blocks pushed the notes and the buttons off the bottom of a phone
screen; the free-text notes still get the room they need underneath.

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

    GET    /api/plants      ->  {"version": 3, "updatedAt": "...",
                                 "species": [...], "plants": [...],
                                 "sowings": [...]}
    PUT    /api/plants      <-  {"species": [...], "plants": [...],
                                 "sowings": [...]}
    PUT    /api/photo/<id>  <-  raw JPEG bytes
    DELETE /api/photo/<id>
    GET    /photos/<id>.jpg

    GET    /api/catalog?q=&temp=&ph=&height=&kind=
                  &edible=&aquatic=&otherUses=  ->  the reference catalogue
    GET    /api/catalog/<pageId>                ->  one entry in full

A `PUT` is **merged** with what is already on disk rather than replacing it —
union by id, most recently updated copy wins, deletes are tombstones. Species,
plants and sowings are three lists of the same shape and go through the same
merge; a client that sends no `species` or `sowings` key at all leaves the ones
on disk alone, which is how a phone running an older copy of the page stays
safe to sync. So two phones edited while apart both keep their changes, in
whatever order they sync, and there is no revision number for the client to
juggle.

The browser keeps a copy in `localStorage`. That is only a cache: it lets the
app keep working while the Pi reboots or Wi-Fi drops, and any edit made
meanwhile is flagged and pushed on the next sync (on launch, when the tab
becomes visible, or when the network returns).

The two catalogue routes are the exception to all of the above: read-only,
never cached on the phone, and answered straight from the SQLite file, which is
opened `mode=ro` and never written by this process. `/data` is not served as a
static directory, so the file cannot be fetched whole — which matters more than
it used to, now that part of it is data nobody has licensed for redistribution.

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
# on the Pi
git clone <this repo> plants && cd plants

# on the machine that built the catalogue — only if you want pfaf's figures,
# which do not travel in the repo. Into the clone, not into /var/lib, so that
# install.sh still stages and restarts it properly.
scp ../plants_db/plants.sqlite plants.local:plants/data/plants.full.sqlite

# back on the Pi
sudo ./install.sh
```

Skip the middle command and you get the Wikipedia-only catalogue that came
with the clone, which is a working one. It is the same `scp` every time the
catalogue is rebuilt after this, and [two catalogues](#two-catalogues) is the
section about why.

That copies the app to `/opt/plants`, creates a system user, puts the data in
`/var/lib/plants`, and enables the service. Override the defaults if you like:

```sh
APP_DIR=/opt/plants DATA_DIR=/var/lib/plants PORT=80 sudo -E ./install.sh
```

Re-running it updates the app, refreshes the catalogue and restarts the
service; it never touches your plant list.

`install.sh` places the catalogue too, taking `data/plants.full.sqlite` where
you have copied one across and `data/plants.sqlite` — which does travel in the
repo — otherwise. So a pull and an install is still the whole update on a Pi
that only wants the Wikipedia figures, and a pull, a `scp` and an install on
one that wants pfaf's as well. See [two catalogues](#two-catalogues).

It is installed the way derived data can be and a plant list cannot: replaced
wholesale, every run. **`plants.json` is never copied from the repo.** The list
on the Pi is the only copy that matters, and overwriting it with a developer's
would be unrecoverable — so the installer takes the catalogue and nothing else
out of `data/`.

The file is staged and renamed rather than written over. The server opens it on
every search, and one landing in the window where a plain copy has truncated it
gets *"Cannot read the catalogue"* — about one request in 400 when measured,
rare enough to be baffling rather than obviously self-inflicted.

The restart at the end of `install.sh` matters for the same reason a fresh
search does not: searches open the file every time and pick up a replacement at
once, but the coverage counts behind the *"of the 5,065 entries, 1,278 record a
soil pH"* line are read once and kept for the life of the process.

Keeping a 4.4 MB binary in git costs a new copy in history every time the dump
is re-mined; at a handful of rebuilds that is fine. The full build is out of
the repo for a licensing reason rather than a size one, and the app did not
notice either way — `--catalog` points anywhere, and the default is just a
list of two names tried in order.

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
- Settings → **Export JSON** saves the plants and the species together;
  **Import JSON** merges both back in, and tolerates a backup taken before
  species existed. Photos are not included — they are files, not JSON.
- Copy the whole data directory off the Pi periodically, photos and all:
  `rsync -a plants.local:/var/lib/plants/ ~/backups/plants/`

The catalogue needs none of this. It is not backed up, not snapshotted and not
exported, because it is derived data: `plants_db` rebuilds it. Losing it costs
CPU, not a plant.

It costs more CPU than it used to, though, and that is worth knowing before
wiping anything. The Wikipedia-only build is in git and one `git checkout`
away. The full one is not, and rebuilding it means re-downloading 27 GB of dump
*and* re-crawling 7,173 pages of pfaf.org at a page a second — the better part
of a day, most of it spent being polite to somebody else's server. Keep the
copy on the machine that built it, which is the copy the Pi's came from.

Writes are atomic — temp file, `fsync`, rename — so a power cut leaves either
the old file or the new one, never a truncated one. That matters more than
usual on an SD card. Prefer `sudo shutdown -h now` over pulling the plug.

## Data format

```json
{
  "version": 3,
  "updatedAt": "2026-08-19T10:00:00Z",
  "species": [
    {
      "id": "sp-7f3a21",
      "name": "Monstera deliciosa",
      "knownAs": "Swiss cheese plant",
      "temps": { "absMin": 5, "avgMin": 18, "avgMax": 27, "absMax": 38 },
      "humidity": { "min": 40, "max": 60 },
      "ph": { "min": 5.5, "max": 7 },
      "light": { "hours": 6, "kind": "indirect" },
      "height": { "min": 2000 },
      "schedule": { "type": "interval", "days": 7 },
      "notes": "Prefers bright indirect light and 20–30 °C.",
      "catalogId": 716481,
      "edible": true,
      "otherUses": true,
      "uses": "The flesh, similar to pineapple in texture, can be eaten.",
      "createdAt": "2026-08-19T09:00:00Z",
      "updatedAt": "2026-08-19T09:00:00Z"
    }
  ],
  "plants": [
    {
      "id": "m1a2b3-x9y8z7",
      "name": "The big one in the kitchen",
      "species": "Monstera deliciosa",
      "speciesId": "sp-7f3a21",
      "place": "inside",
      "temps": null,
      "humidity": { "min": 55, "max": 75 },
      "ph": null,
      "light": { "hours": 3, "kind": "direct" },
      "schedule": null,
      "lastWatered": "2026-08-19",
      "photo": "2026-08-19T10:04:00.000Z",
      "water": "Less in winter",
      "notes": "Bright indirect light. Repotted March 2026.",
      "createdAt": "2026-08-19T10:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    },
    {
      "id": "k9j8h7-a1b2c3",
      "name": "Basil 1",
      "species": "Ocimum basilicum",
      "sowingId": "sw-4c5d6e",
      "place": "outside",
      "temps": { "avgMin": 15 },
      "humidity": null,
      "ph": null,
      "light": null,
      "schedule": { "type": "weekly", "weekdays": [1, 5] },
      "water": "",
      "notes": "Kitchen windowsill.",
      "createdAt": "2026-08-19T10:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    }
  ],
  "sowings": [
    {
      "id": "sw-4c5d6e",
      "species": "Ocimum basilicum",
      "speciesId": "",
      "count": 12,
      "sownOn": "2026-08-12",
      "days": 7,
      "sprouted": 4,
      "dead": 3,
      "notes": "Windowsill propagator.",
      "createdAt": "2026-08-12T09:00:00Z",
      "updatedAt": "2026-08-19T10:00:00Z"
    }
  ]
}
```

A plant with `speciesId` set follows that species wherever its own value is
`null` or absent — the Monstera above takes its temperatures, its soil pH and
its watering interval from the record, and overrides the humidity and the
light. `species` is the
text that was typed; it is kept in step when a species is renamed, and stands
alone for a plant not linked to any record. A `speciesId` naming a species this
device has not synced yet resolves to nothing rather than being an error.

The last five keys on a species are what it kept of the
[catalogue entry](#filling-one-in-from-the-catalogue) it was filled from.
`catalogId` is a Wikipedia page id, and having it is what puts *Open the entry*
and *Fill in again* on the form; the marks and `uses` are there because they
are the only things the catalogue sends that have no box to be edited in. All
five are absent on a species you typed out yourself, and dropping the link
drops all five together. `height` is in whole centimetres and is a species key
only — a plant never carries one — and like the other groups a lone figure in
`min` reads as a ceiling: *to 20 m*. `knownAs` is a species key only too, free
text, and empty or absent until you type in it; see [known as](#known-as).

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

A **sowing** is a third list of the same shape, and the three are merged by the
same code on both ends. `count` is how many seeds went in; `sprouted` and
`dead` are running tallies, and *still trying* is the remainder — there is no
status field, and no key for it. `sprouted` is everything that came up, potted
or not, so the seedlings box on screen is `sprouted` less the plants carrying
this sowing's id: the plants are the record of themselves, and storing them
twice would let the two copies disagree. They are clamped against `count` when read
rather than trusted, because two phones that both potted up the last seedling
would otherwise merge into a sowing claiming more seedlings than seeds.
`days` is `null` or absent when no germination time was given, which is what
keeps a sowing off *Seeds due*; `sownOn` is a local date like `lastWatered`.
`speciesId` works exactly as it does on a plant, except that a sowing carrying
only a `species` name is matched by that name too, so a tray sown before the
species record existed joins it as soon as there is one.

`sowingId` on a plant is the sowing it was potted up from. Nothing else about a
plant reads it — it is what puts the plant under *Plants from this sowing*, and
it is absent on every plant that was not grown from seed here.

A deleted plant keeps its entry with a `deletedAt` timestamp, so that a phone
that was offline during the delete cannot bring it back. Species and sowings
are tombstoned the same way; deleting a sowing does not touch the plants it
produced.

## Local development

```sh
python3 server.py --port 8080 --data ./data/plants.json
```

then open <http://localhost:8080>. There is nothing to build.

The catalogue is looked for next to the data file — `plants.full.sqlite`
first, then `plants.sqlite` — so dropping either into `./data/` is all it
takes; `--catalog` points elsewhere. Without one everything still runs and the
catalogue view says it is not installed. The startup line tells you which you
have, and a clone straight from git has the second:

```
plants: catalogue /home/…/data/plants.full.sqlite (ready)
```
