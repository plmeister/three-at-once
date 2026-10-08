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
}

export function validOrigin(o) {
  if (!o) return false
  if (o.kind === 'group') {
    return typeof o.label === 'string' && o.label && Array.isArray(o.stops) && o.stops.length > 0
  }
  return typeof o.atco === 'string' && o.atco && o.label
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
