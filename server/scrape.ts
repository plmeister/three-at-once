import type {
  Departure,
  Departures,
  Direction,
  LocalityStops,
  Nearby,
  SearchEntry,
  Service,
  ServiceStops,
  StopRef,
  StopServices,
} from './types.ts'

const BASE = 'https://bustimes.org'
const BUSES_REFERER = 'https://bustimes.org/'
const UA = 'three-at-once/0.1 (local bus-times app; rate-limited, cached)'
const MIN_GAP_MS = Number(process.env.UPSTREAM_GAP_MS || 300)
const TIMEOUT_MS = 15000

let lastUpstreamAt = 0
let upstreamTail: Promise<unknown> = Promise.resolve()

function throttle(): Promise<unknown> {
  const gap = () => {
    const wanted = lastUpstreamAt + MIN_GAP_MS - Date.now()
    lastUpstreamAt = Date.now()
    return wanted > 0 ? wanted : 0
  }
  const next = upstreamTail.then(() => new Promise((r) => setTimeout(r, gap())))
  upstreamTail = next
  return next
}

export async function fetchUpstream(path: string, { retries = 1 }: { retries?: number } = {}): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(BASE + path, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB' },
        signal: ctrl.signal,
        redirect: 'follow',
      })
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after')) || 5
        await new Promise((r) => setTimeout(r, retry * 1000))
        continue
      }
      if (!res.ok) {
        lastErr = new Error(`upstream ${res.status} for ${path}`)
        continue
      }
      return await res.text()
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error(`upstream failed for ${path}`)
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&shy;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseSearch(html: string): SearchEntry[] {
  const localities: SearchEntry[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<li>\s*<a href="\/localities\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    const name = stripTags(m[2])
    if (!name) continue
    const [primary, ...parts] = name.split(', ')
    localities.push({
      slug: m[1],
      name: primary,
      qualifier: parts.join(', ') || null,
    })
    if (localities.length >= 25) break
  }
  return localities
}

export function parseLocality(html: string): LocalityStops {
  const stops: StopRef[] = []
  for (const m of html.matchAll(/<li>\s*<a href="\/stops\/([0-9A-Za-z]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const span = m[2].match(/<span>([\s\S]*?)<\/span>/)
    const label = stripTags(span ? span[1] : m[2])
    if (!label) continue
    const lines = [
      ...new Set(
        [...m[2].matchAll(/<small>([\s\S]*?)<\/small>/g)]
          .map((lm) => stripTags(lm[1]))
          .filter(Boolean)
      ),
    ]
    stops.push({ atco: m[1], label, name: label, lines })
  }
  return { stops }
}

function splitClosingDiv(html: string, openPos: number): string | null {
  let depth = 1
  let i = openPos
  while (depth > 0) {
    const nextOpen = html.indexOf('<div', i)
    const nextClose = html.indexOf('</div>', i)
    if (nextClose === -1) return null
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      i = nextOpen + 4
    } else {
      depth--
      i = nextClose + 6
    }
  }
  return html.slice(openPos, i)
}

function rowCells(rowHtml: string): string[] {
  const cells: string[] = []
  let pos = 0
  while (pos < rowHtml.length) {
    const open = rowHtml.indexOf('<td', pos)
    if (open === -1) break
    const close = rowHtml.indexOf('</td>', open)
    if (close === -1) break
    cells.push(rowHtml.slice(open, close + 5))
    pos = close + 5
  }
  return cells
}

export function parseStopServices(html: string): StopServices {
  const blockMatch = html.match(/<h2>[^<]*services[^<]*<\/h2>([\s\S]*?)<\/ul>/i)
  if (!blockMatch) return { services: [] }
  const block = blockMatch[1]
  const ulPos = block.indexOf('<ul class="has-smalls">')
  const region = ulPos === -1 ? block : block.slice(ulPos)
  const services: Service[] = []
  const seen = new Set<string>()
  for (const m of region.matchAll(/<li>\s*<a href="\/services\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    const nameStrong = m[2].match(/<strong class="name[^"]*">([\s\S]*?)<\/strong>/)
    const descSpan = m[2].match(/<span class="description">([\s\S]*?)<\/span>/)
    const opSmall = m[2].match(/<small>([\s\S]*?)<\/small>/)
    if (!nameStrong) continue
    services.push({
      slug: m[1],
      line: stripTags(nameStrong[1]) || null,
      headline: descSpan ? stripTags(descSpan[1]) : null,
      operators: opSmall
        ? stripTags(opSmall[1])
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    })
  }
  return { services }
}

// A service page holds one timetable table per direction, each row a stop in
// running order with the times the trips call there. Splitting on groupings
// keeps variant journeys under one heading from overwriting each other.
const STOP_ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/g

function parseStopRows(tableHtml: string): { atco: string; name: string; times: string[] }[] {
  const stops: { atco: string; name: string; times: string[] }[] = []
  for (const row of tableHtml.matchAll(STOP_ROW_RE)) {
    const link = row[1].match(/<a href="\/stops\/([0-9A-Za-z]+)">([^<]*)<\/a>/)
    if (!link) continue
    const name = link[2].replace(/\s+/g, ' ').trim()
    if (!name) continue
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]))
    const lead = cells.length && !cells[0] ? cells.slice(1) : cells
    stops.push({ atco: link[1], name, times: lead })
  }
  return stops
}

export function parseServiceStops(html: string): ServiceStops {
  const calendar =
    html.match(/<option selected[^>]*>([\s\S]*?)<\/option>/)?.[1]?.replace(/\s+/g, ' ').trim() || null
  const byName = new Map<string | null, { name: string | null; stops: ReturnType<typeof parseStopRows>; seen: Set<string> }>()
  for (const chunk of html.split('<div class="grouping"').slice(1)) {
    const table = chunk.match(/<table class="timetable">([\s\S]*?)<\/table>/)
    if (!table) continue
    const stops = parseStopRows(table[1])
    if (!stops.length) continue
    const name = stripTags(chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] || '') || null
    const dir = byName.get(name) || { name, stops: [], seen: new Set<string>() }
    for (const s of stops) {
      if (dir.seen.has(s.atco)) continue
      dir.seen.add(s.atco)
      dir.stops.push(s)
    }
    byName.set(name, dir)
  }
  return {
    calendar,
    directions: [...byName.values()].map(({ name, stops }) => ({ name, stops })),
  }
}

function cellTime(cellHtml: string | undefined | null): string | null {
  if (!cellHtml) return null
  const m = cellHtml.match(/(\d{1,2}:\d{2})\s*</)
  return m ? m[1] : null
}

function firstHref(cellHtml: string | undefined): string | null {
  if (!cellHtml) return null
  const m = cellHtml.match(/href="([^"]+)"/)
  return m ? m[1] : null
}

export function parseDepartures(html: string): Departures | null {
  const asidePos = html.indexOf('<div class="aside" id="departures">')
  if (asidePos === -1) return null
  const segment = splitClosingDiv(html, asidePos)
  if (!segment) return null

  const thead = segment.match(/<thead[\s\S]*?<\/thead>/i)
  const headers = thead ? [...thead[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => stripTags(m[1])) : []

  const hasSched = headers.some((h) => /^sched/i.test(h))
  const hasLive = headers.some((h) => /^exp/i.test(h))
  const hasBay = headers.some((h) => /^stand|^stance|^bay|^stop/i.test(h))

  const rows: Departure[] = []
  let date: string | null = null
  for (const part of segment.split('<h3>').slice(1)) {
    const h3 = part.slice(0, part.indexOf('</h3>'))
    const m = h3.match(/(\d{1,2} \w+ \d{4})/)
    if (m) date = m[1]
  }

  for (const row of segment.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = rowCells(row[1])
    if (cells.length < 2) continue
    const lineCell = cells[0]
    const destCell = cells[1]

    const line = stripTags(lineCell)
    const serviceUrl = firstHref(lineCell) || null

    const dest = stripTags(destCell).replace(/ \d{2,5} - [A-Z]{2}\d{2} [A-Z]{3}$/, '')
    let bay: string | null = null
    if (hasBay && cells.length > 3) bay = stripTags(cells[cells.length - 1])
    const bi = stripTags(destCell.match(/<div class="vehicle">([\s\S]*?)<\/div>/)?.[1] || '')
    const vehicle = bi || null

    let sched: string | null = null
    let expected: string | null = null
    let cancelled = false
    if (hasSched && cells.length > 2) {
      const sc = cells[2]
      sched = cellTime(sc)
      cancelled = /<s>[\s\S]*<\/s>/.test(sc)
    }
    if (hasLive && cells.length > (hasSched ? 3 : 2)) {
      const lc = cells[hasSched ? 3 : 2]
      expected = cellTime(lc)
    }
    const tripUrl = firstHref(cells[hasSched ? 2 : 1]) || null

    rows.push({
      date,
      line,
      destination: dest,
      vehicle,
      bay,
      scheduled: sched,
      expected,
      cancelled,
      serviceUrl,
      tripUrl,
    })
  }

  return {
    hasScheduled: hasSched,
    hasLive,
    departures: rows,
  }
}

export async function fetchExternal(
  url: string,
  { retries = 1 }: { retries?: number } = {},
  headers: Record<string, string> = {}
): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-GB',
          Referer: BUSES_REFERER,
          ...headers,
        },
        signal: ctrl.signal,
        redirect: 'follow',
      })
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after')) || 5
        await new Promise((r) => setTimeout(r, retry * 1000))
        continue
      }
      if (!res.ok) {
        lastErr = new Error(`external ${res.status} for ${url}`)
        continue
      }
      return await res.text()
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error('external fetch failed')
}

export function parseNearby(jsonText: string): Nearby {
  const j = JSON.parse(jsonText)
  const a = j.address || {}
  const order = ['town', 'city', 'village', 'hamlet', 'suburb', 'neighbourhood', 'municipality', 'county_town']
  const names: string[] = []
  for (const k of order) {
    if (a[k] && !names.includes(a[k])) names.push(a[k])
  }
  if (j.name && !names.includes(j.name)) names.push(j.name)
  return {
    names: names.slice(0, 4),
    label: (j.display_name || '').split(',')[0] || names[0] || '',
    lat: j.lat ? Number(j.lat) : null,
    lon: j.lon ? Number(j.lon) : null,
  }
}

export const scrapers = {
  search: { parse: parseSearch, path: (q: string) => `/search?q=${encodeURIComponent(q)}` },
  locality: {
    parse: parseLocality,
    path: (slug: string) => `/localities/${encodeURIComponent(slug)}`,
  },
  departures: {
    parse: parseDepartures,
    path: (atco: string) => `/stops/${encodeURIComponent(atco)}`,
  },
  serviceStops: {
    parse: parseServiceStops,
    path: (slug: string) => `/services/${encodeURIComponent(slug)}`,
  },
}

export type { Direction, Service }
