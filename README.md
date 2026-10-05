# Which Bus?

Next-bus board for your stop. Scheduled + live departure times, destination
filter, bay/platform, installable PWA. No accounts, no LLM.

Data pulled from [bustimes.org](https://bustimes.org) (self-service, no API
key). App is two parts: a Vite vanilla-JS PWA front end plus a tiny dependency-free
Node proxy that scrapes bustimes.org pages, parses them into JSON, and caches
politely.

Flow: pick your **departure point** (stop, or a merged board like "Hull
Interchange" / "Riverhead Exchange" / "Cottingham King Street" that collapses
several physical stops into one list), then set a **destination** — the board
narrows to buses that serve both. Each row reads like the front of the bus:
**bus number + final destination**, the exact stop it departs from (bay/stand on
merged boards), scheduled and expected times, plus an estimated **arrival** at
your destination (joined bus-by-bus the same trip: the destination stop's own
time for that trip, live where available). A bus-company filter narrows to
operators whose tickets cover both legs.

## What merges into one board

A locality list collapses stops that are really one place to stand:

- **Bays/stands** — "Hull Interchange (Bay 1)", "(Bay 10)", "(Bay A)" → one
  "Hull Interchange" card.
- **Lettered stands** — "Alfred Gelder Street A →", "F ←" → one
  "Alfred Gelder Street" card.
- **Directional kerb pairs** — "Cottingham King Street ↑", "Cottingham King
  Street ↓" → one "Cottingham King Street" card. Bus stops are directional, so
  the same road both ways is the same journey; rows still name the kerb, and the
  destination filter drops the half that goes the wrong way.

Every member stop is loaded, so a merged board is a superset — and a merged card
works as the **destination** too (the filter pools all its stops' routes).

## Run

```bash
npm install
npm run dev       # api on :4848 + vite on :5173 (proxy /api -> :4848)
```

Open http://localhost:5173. Pick a stop by place name (e.g. `Sculcoates` →
stop → board). Stop is remembered in `localStorage`. Right-click the origin
pill to clear it.

Production:

```bash
npm run build
npm start         # serves ./dist + /api on :4848
```

## Configure the default origin

`src/config.js` → `DEFAULT_ORIGIN`:

```js
export const DEFAULT_ORIGIN = { atco: '2290YHA00113', label: 'Sculcoates, Anchor Road', lines: ['21'] }
```

## Sharing a journey

The **⇪** button on a board returns a copy/share link like
`…/whichbus/?s=…&saved=1` — a base64url snapshot of the departure point
(single stop or merged group), destination and destination filter. Opening it
boots that exact board, so you can paste it in chat/email and someone else sees
the same routes and times. Legacy `?atco=…&name=…` links still work.

## API (`:4848/api`)

| Route | Params | Returns |
|---|---|---|
| `GET /api/search` | `q` | `{ localities: [{ slug, name, qualifier }] }` |
| `GET /api/locality` | `slug` | `{ slug, stops: [{ atco, label, name, lines }] }` |
| `GET /api/departures` | `atco` | `{ atco, hasScheduled, hasLive, departures: [{ date, line, destination, vehicle, bay, scheduled, expected, cancelled, serviceUrl, tripUrl }] }` |
| `GET /api/stop-services` | `atco` | `{ atco, services: [{ slug, line, headline, operators: string[] }] }` |
| `GET /api/service-stops` | `slug` | `{ slug, calendar, directions: [{ name, stops: [{ atco, name, times: string[] }] }] }` — every stop on a route, both directions, in running order |
| `GET /api/nearby` | `lat lon` | `{ names, label, lat, lon }` — reverse-geocodes a map pin (OpenStreetMap Nominatim, 7-day cache) |

Add a **destination**: "＋ Set destination…" → pick a stop or a merged card.
Board then shows only departures whose bus also calls at the destination (service-URL slug
match, line-name fallback), shown as a "To: … ✕" chip to clear. Each shared
row gets an arrival estimate joined by trip URL. The **⭑** button names and
saves the whole journey; the ★ next to it bookmarks just the stop.

## Which buses stop here, and what a route actually does

Two questions the board used to make you guess at:

- **"What else calls here?"** The **"N services call here"** panel under the
  filters lists *every* service at your stop — including ones with no bus in the
  current 24-hour window — as `line · where it goes · next departure`, with a
  `–` and dimmed styling when nothing is due. Tap a chip to narrow the board to
  that service; tap again to clear. On a merged board the count pools all its
  member stops, fetched on first expand rather than up front.
- **"What does route 41 actually do?"** The route number on each row is a
  button, not a link. It opens the stop list for that service in running order,
  one tab per direction, with your stop highlighted ("you are here"), your
  destination marked, and the timetable times under each stop when you tap it.
  The pill that appears when a route filter is active opens the same thing, so
  routes with no departure on screen are still inspectable. A "timetable ↗" link
  to bustimes.org sits in the header.

  Desktop: **hover or focus** the route number for a floating card that closes
  when you leave. Touch: **tap** for a bottom sheet (backdrop, Esc, ✕, body
  scroll locked). One renderer, one fetch path — the only difference is
  presentation, so there is no mobile-only behaviour to fall out of sync.

Data comes from `/api/service-stops` — the service page's timetable tables, one
per direction, each row a stop plus its times. It's a ~90KB page per service, so
it's fetched on first open only (never speculated), cached 14 days upstream, and
kept in a client-side `Map` for the session with in-flight de-duplication. Worst
case (a long route like 41, 86 + 94 stops) is ~32KB of JSON.

## Smarter destination choices (from favourites)

When you've picked a departure point and the "choose destination" search is
open, the app cross-references your **favourite stops** against the origin's
routes. Each favourite that shares at least one bus line gets an annotated
chip — the next departure from here I can catch (`🚌 21 · 09:42 → Hull`), plus
a live-linked arrival estimate at that stop (`arr 10:05`) when the two stops
are on the same trip. Favourites with no common line get a muted
"no direct bus from <origin>" note. Great when several stops would all get you
home but you want the one where the next bus actually leaves soonest.

## Locate your departure point

The "📍 Use my location" button in the search dialog asks the browser for your
position (permission prompt on first use), reverse-geocodes it via OpenStreetMap
Nominatim, and jumps straight to the bus stops for the place you're in — pick
one and it's your origin, no typing.

## Saved journeys & stops

Favourites live **entirely in your browser** (`localStorage`, key
`whichbus:v1`) — no accounts, no login, no backend database; share/restore
between devices via the ⇪ link instead.

- **Stop**: ☆ on a board (or on the hero's "Favourite stops" list) saves the
  departure point.
- **Journey**: with a destination set, ⭑ lets you **name** the trip (e.g.
  "To work") and saves origin + destination + operator + destination filter.
  Saved journeys appear on the "start again" hero as named one-tap chips.

No upstream API key needed. Upstream calls are throttled (≥300ms apart,
~2/s max), cached (search/locality/stop-services 30 min, departures 20 s),
and sent with a descriptive User-Agent. Don't hammer bustimes.org; respect
their robots.txt.

## Notes / known limits

- "Expected" column shows live times only where the operator publishes SIRI
  data; otherwise Scheduled only.
- Bay/platform shown for station boards (from "Stand/Stance/Bay" column);
  for street stops the "Stop 3" indicator chip comes from the stop label.
- Arrival estimates join the *same trip* between your two stops (by bustimes
  trip URL) using the destination stop's own departure entry for that trip —
  so they inherit its live "expected" time when the operator publishes SIRI
  data. No estimate when the two stops are on different trips (e.g. you pick
  a terminus that no passing bus serves).
- **Direction-aware.** Stops are directional, and two stops can share a bus
  line yet sit on opposite branches. The board (and the favourite-stop hints)
  check the destination stop's own departures: a row is dropped as *wrong
  direction* when the destination demonstrably serves that line the other way
  (mismatched terminus), and confirmed when the same trip URL appears at both
  stops — provided it reaches the destination *after* the origin (scheduled
  stop-time order; a shared trip already past the destination is reversed).
  No directional evidence (e.g. a merged interchange group) falls back to the
  plain line-set match, so nothing valid is ever hidden.
- A destination that is a merged card pools every member stop's routes and
  termini, so direction checks get *weaker* evidence, not stronger — again
  biased towards showing a bus rather than hiding one.
- Chosen origin persists in `localStorage`; install prompt via service
  worker (offline shows last-fetched board).
- Route stop lists come from the service page's **default timetable** (the first
  calendar upstream picks, e.g. "Monday to Friday"), so a Sunday-only variation
  won't appear. Where a service publishes variant journeys under one heading,
  their stops are merged in service order; duplicate stops are dropped.
- Scrapes HTML — upstream layout changes can break parsing
  (`server/scrape.mjs`).

## Test

Both suites are live end-to-end runs (jsdom + real bustimes.org), so they need
network and a warm-ish cache.

`npm test` drives the whole app against a **running** server:

```bash
npm run build && npm start          # in another shell
npm test
```

It defaults to `http://localhost:4848` root-hosted. To point it at a deployed
instance, override both — the test never assumes a hostname:

```bash
WB_ORIGIN=https://my-host WB_BASE=/whichbus npm test
```

`WB_BASE` defaults to `/whichbus`; set it empty (`WB_BASE=`) for a root-hosted
local server.

`npm run test:route` is the focused route-detail check: it spawns the API on
:4851, drives the bundle in jsdom, and asserts the services panel, the route
filter, and both route presentations (hover card, tap sheet, direction tabs,
"you are here" marker). No server to start first; still needs network.

## Deploy (Traefik subpath)

See `~/docker-stuff/stacks/README.md`. Summary:

1. `docker network create whichbus-net`
2. Give the stack `whichbus-net` + `proxy-net`, and put the route in the stack's
   **container labels** (Traefik watches the Docker socket, `exposedByDefault=false`):
   - `traefik.http.routers.whichbus.rule=Host(\`your-host\`) && PathPrefix(\`/whichbus\`)`
   - `entrypoints=websecure` + `tls.certresolver=letsencrypt`
   - `middlewares=authelia-slash@file,…,whichbus-strip@docker` with
     `whichbus-strip.stripprefix.prefixes=/whichbus`
   - `sablier.enable=true` + group, for scale-to-zero
3. `docker compose -f ~/docker-stuff/stacks/whichbus/compose.yaml up -d --build`
4. Stack compose builds with `VITE_BASE=/whichbus/` (all asset/API/`start_url`
   paths are base-relative, so subpath hosting works).

**The public URL lives in exactly one place: the stack compose's Traefik
labels.** Nothing in this repo hardcodes a hostname — the app derives every URL
from `import.meta.env.BASE_URL` and `window.location`, and share links are built
from the current location. The only absolute URLs in code are genuine third
parties (bustimes.org, OpenStreetMap, unpkg).

## Roadmap (later)

- Route stop list as a little map (stop dots + your position), like the service page.
- Multiple saved origins · walking time to bay
  · live vehicle position · delay/cancel notifications.