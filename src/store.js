import { DEFAULT_ORIGIN } from './config.js'

const KEY = 'whichbus:v1'

const defaultState = {
  origin: DEFAULT_ORIGIN
    ? { atco: DEFAULT_ORIGIN.atco, label: DEFAULT_ORIGIN.label, lines: DEFAULT_ORIGIN.lines || [] }
    : null,
  toStop: null,
  destination: '',
  operator: '',
  favourites: [],
  favJourneys: [],
  groups: [],
}

export function validOrigin(o) {
  if (!o) return false
  if (o.kind === 'group') {
    return typeof o.label === 'string' && o.label && Array.isArray(o.stops) && o.stops.length > 0
  }
  return typeof o.atco === 'string' && o.atco && o.label
}

function validMember(m) {
  if (!m || typeof m !== 'object') return false
  if (m.kind === 'group') return typeof m.label === 'string' && !!m.label && Array.isArray(m.stops) && m.stops.length > 0
  return typeof m.atco === 'string' && !!m.atco && typeof m.label === 'string' && !!m.label
}

export function validGroup(g) {
  return !!g && typeof g.name === 'string' && g.name.trim() && Array.isArray(g.members) && g.members.some(validMember)
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw) return defaultState
    const origin = validOrigin(raw.origin) ? raw.origin : null
    const viaLegacy = raw.via && !raw.toStop ? raw.via : raw.toStop
    return {
      origin,
      toStop: validOrigin(viaLegacy) ? viaLegacy : null,
      destination: typeof raw.destination === 'string' ? raw.destination : '',
      operator: typeof raw.operator === 'string' ? raw.operator : '',
      favourites: Array.isArray(raw.favourites) ? raw.favourites.filter(validOrigin) : [],
      favJourneys: Array.isArray(raw.favJourneys)
        ? raw.favJourneys.filter((f) => f && typeof f.name === 'string' && f.name && validOrigin(f.origin) && validOrigin(f.toStop))
        : [],
      groups: Array.isArray(raw.groups) ? raw.groups.filter(validGroup) : [],
    }
  } catch {
    return defaultState
  }
}

let state = load()

export function getState() {
  return state
}

export function setOrigin(origin) {
  state = { ...state, origin: validOrigin(origin) ? origin : null, toStop: null, destination: '', operator: '' }
  persist()
}

export function clearOrigin() {
  state = { ...state, origin: null, toStop: null, destination: '', operator: '' }
  persist()
}

export function setToStop(stop) {
  state = { ...state, toStop: validOrigin(stop) ? stop : null, operator: '' }
  persist()
}

export function setDestination(destination) {
  state = { ...state, destination }
  persist()
}

export function setOperator(operator) {
  state = { ...state, operator }
  persist()
}

// ---- favourites ----------------------------------------------------------

export function favKey(o) {
  if (!o) return null
  return o.kind === 'group' ? `group:${String(o.label).toLowerCase()}` : o.atco
}

export function isFavourite(o) {
  const k = favKey(o)
  return !!k && state.favourites.some((f) => favKey(f) === k)
}

export function addFavourite(o) {
  if (!validOrigin(o)) return
  const k = favKey(o)
  if (state.favourites.some((f) => favKey(f) === k)) return
  state = { ...state, favourites: [...state.favourites, o] }
  persist()
}

export function removeFavourite(o) {
  const k = favKey(o)
  state = { ...state, favourites: state.favourites.filter((f) => favKey(f) !== k) }
  persist()
}

export function getFavourites() {
  return state.favourites
}

// ---- favourite journeys ---------------------------------------------------

export function journeyKey(origin, toStop) {
  if (!origin || !toStop) return null
  return `${favKey(origin)}|${favKey(toStop)}`
}

export function getFavJourneys() {
  return state.favJourneys
}

export function isFavJourney(origin, toStop) {
  const k = journeyKey(origin, toStop)
  return !!k && state.favJourneys.some((f) => journeyKey(f.origin, f.toStop) === k)
}

export function saveFavouriteJourney(j) {
  if (!j || typeof j.name !== 'string' || !j.name) return
  if (!validOrigin(j.origin) || !validOrigin(j.toStop)) return
  const k = journeyKey(j.origin, j.toStop)
  const rest = state.favJourneys.filter((f) => journeyKey(f.origin, f.toStop) !== k)
  state = {
    ...state,
    favJourneys: [
      {
        name: j.name,
        origin: j.origin,
        toStop: j.toStop,
        destination: typeof j.destination === 'string' ? j.destination : '',
        operator: typeof j.operator === 'string' ? j.operator : '',
      },
      ...rest,
    ],
  }
  persist()
}

export function removeFavJourney(origin, toStop) {
  const k = journeyKey(origin, toStop)
  state = { ...state, favJourneys: state.favJourneys.filter((f) => journeyKey(f.origin, f.toStop) !== k) }
  persist()
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* private mode */
  }
}

// ---- shared URLs ---------------------------------------------------------

function bytesToB64url(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(b64) {
  const safe = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(safe)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function buildShareUrl({ saved = true } = {}) {
  const payload = {
    o: state.origin || undefined,
    t: state.toStop || undefined,
    d: state.destination || undefined,
    op: state.operator || undefined,
  }
  const b64 = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)))
  const url = new URL(window.location.href)
  url.search = `?s=${b64}${saved ? '&saved=1' : ''}`
  return url.toString()
}

export function sharedStateFromUrl() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('saved')) return null
  const raw = params.get('s')
  if (raw) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw)))
      const origin = validOrigin(payload.o) ? payload.o : null
      const toStop = validOrigin(payload.t) ? payload.t : null
      return {
        origin,
        toStop,
        destination: typeof payload.d === 'string' ? payload.d : '',
        operator: typeof payload.op === 'string' ? payload.op : '',
      }
    } catch {
      /* fall through to legacy */
    }
  }
  const atco = params.get('atco')
  if (!atco) return null
  return {
    origin: { atco, label: params.get('name') || atco, lines: [] },
    toStop: null,
    destination: '',
    operator: '',
  }
}
export function toggleFavourite(o) {
  if (!validOrigin(o)) return
  const key = favKey(o)
  if (!key) return
  const exists = state.favourites.some((f) => favKey(f) === key)
  if (exists) {
    state.favourites = state.favourites.filter((f) => favKey(f) !== key)
  } else {
    state.favourites.push(o)
  }
  persist()
}

// ---- custom groups ("Home" = a handful of nearby stops) --------------------

function newGroupId() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getGroups() {
  return state.groups
}

export function getGroup(id) {
  return state.groups.find((g) => g.id === id) || null
}

// Flatten members (stops and nested bus groups) into the board's group shape.
// De-duplicated by atco so the same bay added via two routes counts once.
export function resolveGroup(g) {
  if (!g) return null
  const stops = []
  const seen = new Set()
  const push = (s) => {
    if (!s?.atco || seen.has(s.atco)) return
    seen.add(s.atco)
    stops.push({ atco: s.atco, label: s.label || s.atco, lines: s.lines || [] })
  }
  for (const m of g.members || []) {
    if (m.kind === 'group') for (const s of m.stops || []) push(s)
    else push(m)
  }
  return {
    kind: 'group',
    custom: true,
    id: g.id,
    label: g.name,
    stops,
    lines: [...new Set(stops.flatMap((s) => s.lines || []))],
  }
}

export function saveGroup(g) {
  const members = (g?.members || []).filter(validMember)
  const name = String(g?.name || '').trim()
  if (!name || !members.length) return null
  const id = g.id || newGroupId()
  const next = { id, name, members }
  const idx = state.groups.findIndex((x) => x.id === id)
  const groups = state.groups.slice()
  if (idx >= 0) groups[idx] = next
  else groups.push(next)
  state = { ...state, groups }
  persist()
  return next
}

export function removeGroup(id) {
  state = { ...state, groups: state.groups.filter((g) => g.id !== id) }
  persist()
}

// ---- backup / sync --------------------------------------------------------

export function exportData() {
  return {
    app: 'whichbus',
    version: 1,
    exportedAt: new Date().toISOString(),
    origin: state.origin || null,
    toStop: state.toStop || null,
    favourites: state.favourites,
    favJourneys: state.favJourneys,
    groups: state.groups,
  }
}

function validJourney(j) {
  return j && typeof j.name === 'string' && j.name && validOrigin(j.origin) && validOrigin(j.toStop)
}

function unionBy(existing, incoming, keyOf) {
  const out = existing.slice()
  const seen = new Set(existing.map(keyOf))
  for (const item of incoming) {
    const k = keyOf(item)
    if (k == null || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

// Merge (default) keeps local entries and adds anything new; replace swaps the
// whole set. Either way only structurally valid entries survive.
export function importData(data, { merge = true } = {}) {
  if (!data || typeof data !== 'object') throw new Error('Not a Which Bus backup file')
  const favourites = Array.isArray(data.favourites) ? data.favourites.filter(validOrigin) : []
  const favJourneys = Array.isArray(data.favJourneys) ? data.favJourneys.filter(validJourney) : []
  const groups = Array.isArray(data.groups) ? data.groups.filter(validGroup) : []
  const groupKey = (g) => String(g.name || '').trim().toLowerCase()
  if (merge) {
    state = {
      ...state,
      favourites: unionBy(state.favourites, favourites, favKey),
      favJourneys: unionBy(state.favJourneys, favJourneys, (j) => journeyKey(j.origin, j.toStop)),
      groups: unionBy(state.groups, groups, groupKey),
    }
  } else {
    state = { ...state, favourites, favJourneys, groups }
  }
  persist()
  return {
    favourites: state.favourites.length,
    favJourneys: state.favJourneys.length,
    groups: state.groups.length,
  }
}
