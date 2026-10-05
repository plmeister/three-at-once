// Direction / stop-ordering reasoning for single-bus legs.
//
// A stop is directional: the departures it lists all head one way along each
// line. Two stops may share a line number yet sit on opposite branches, so a
// line-set match alone can recommend a "journey" no bus actually makes. These
// helpers judge a candidate origin departure against what the destination stop
// demonstrably sees, turning "serve both stops" into "this trip really reaches
// the destination".

export const DIR = {
  CONFIRMED: 'confirmed', // same trip calls at both stops — ground truth
  COMPAT: 'compat',       // same line, matching terminus — direction-compatible
  AMBIGUOUS: 'ambiguous', // no directional evidence either way — keep current guess
  WRONG: 'wrong',         // dest stop demonstrably serves this line the other way
}

// Profile a stop from its own departure board: per line, the termini its buses
// head for and the trips it sees.
export function stopDirProfile(departures) {
  const byLine = new Map()
  for (const d of departures || []) {
    if (!d.line) continue
    let p = byLine.get(d.line)
    if (!p) {
      p = { termini: new Set(), trips: new Set(), times: new Map() }
      byLine.set(d.line, p)
    }
    if (d.destination) p.termini.add(d.destination)
    if (d.tripUrl) {
      p.trips.add(d.tripUrl)
      const t = d.scheduled || d.expected
      if (t) p.times.set(d.tripUrl, t)
    }
  }
  return byLine
}

// Judge one origin departure against a destination stop's profile.
// A shared trip only counts when the destination is served at or after the
// origin: scheduled times strictly increase along a run, so if the dest stop's
// board sees the same trip EARLIER, the bus is past the destination and heading
// away — reversing it would be riding into the travel direction.
function departTime(d) {
  const [h, m] = String(d?.scheduled || d?.expected || '').split(':').map(Number)
  return Number.isFinite(h) ? (h || 0) * 60 + (m || 0) : null
}

// minutes-till minutes, tolerating mild HH:MM wraparound past midnight.
function afterMinutes(aMin, bMin) {
  let diff = aMin - bMin
  if (diff > 720) diff -= 1440
  if (diff < -720) diff += 1440
  return diff
}

export function legVerdict(dep, dest) {
  if (!dest) return DIR.AMBIGUOUS
  const p = dest.get(dep.line)
  const depMin = departTime(dep)
  if (dep.tripUrl && p?.trips?.has(dep.tripUrl)) {
    const destMin = departTime({ scheduled: p.times.get(dep.tripUrl) })
    if (depMin !== null && destMin !== null) {
      return afterMinutes(destMin, depMin) >= 0 ? DIR.CONFIRMED : DIR.WRONG
    }
    return DIR.CONFIRMED // no timestamps to compare — trust the shared trip
  }
  if (!p) return DIR.AMBIGUOUS // dest window shows no trips on this line — no evidence to exclude
  if (!p.termini.size) return DIR.AMBIGUOUS
  return dep.destination && p.termini.has(dep.destination) ? DIR.COMPAT : DIR.WRONG
}

// Pick the best (earliest) origin departure that plausibly reaches the
// destination. Returns null only when directional evidence proves every
// candidate goes the wrong way.
export function bestSharedLeg(departures, dest, sharedLines) {
  const matches = [...departures]
    .filter((d) => sharedLines.has(d.line))
    .sort((a, b) => {
      const t = (x) => {
        const [h, m] = String(x.scheduled || x.expected || '').split(':').map(Number)
        return Number.isFinite(h) ? h * 60 + (m || 0) : 99 * 60
      }
      return t(a) - t(b)
    })
  if (!dest) return matches[0] || null
  const avail = matches.filter((d) => legVerdict(d, dest) !== DIR.WRONG)
  if (avail.length) return avail[0]
  return matches.some((d) => legVerdict(d, dest) === DIR.WRONG) ? null : matches[0] || null
}