// Shared shapes for the search index and the scraped feed payloads.

export interface Locality {
  /** slug — stable id used in URLs and the search index */
  s: string
  /** display name */
  n: string
  /** breadcrumb, outermost-last: ["Beverley Road", "Hull"] */
  c: string[]
  qualifier?: string | null
  /** legacy alias for `n` (older index files) */
  name?: string
}

export interface Stop {
  /** ATCO code — the upstream (bustimes.org) key */
  a: string
  /** NaptanCode alias, if any */
  na?: string
  /** stop name */
  l: string
  /** locality slug */
  s?: string | null
  /** breadcrumb, c[0] is the stop's own locality */
  c: string[]
  /** longitude */
  x?: number
  /** latitude */
  y?: number
  /** legacy aliases (older index files) */
  slug?: string
  loc?: string
  label?: string
}

export interface SearchIndex {
  builtAt?: string
  localities: Locality[]
  stops: Stop[]
}

export interface Departure {
  date: string | null
  line: string
  destination: string
  vehicle: string | null
  bay: string | null
  scheduled: string | null
  expected: string | null
  cancelled: boolean
  serviceUrl: string | null
  tripUrl: string | null
}

export interface Departures {
  hasScheduled: boolean
  hasLive: boolean
  departures: Departure[]
}

export interface StopRef {
  atco: string
  label?: string
  name: string
  lines?: string[]
  times?: string[]
}

export interface LocalityStops {
  stops: StopRef[]
}

export interface Service {
  slug: string
  line: string | null
  headline: string | null
  operators: string[]
}

export interface StopServices {
  services: Service[]
}

export interface Direction {
  name: string | null
  stops: { atco: string; name: string; times: string[] }[]
}

export interface ServiceStops {
  calendar: string | null
  directions: Direction[]
}

export interface SearchEntry {
  slug: string
  name: string
  qualifier: string | null
}

export interface Nearby {
  names: string[]
  label: string
  lat: number | null
  lon: number | null
}
