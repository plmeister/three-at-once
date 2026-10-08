import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCache } from './cache.mjs'
import {
  parseDepartures, parseLocality, parseNearby, parseSearch, parseServiceStops, parseStopServices,
  fetchUpstream, fetchExternal,
} from './scrape.mjs'

const PORT = Number(process.env.PORT || 4848)
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const DAY = 24 * 60 * 60 * 1000
const TTL = {
  search: 30 * DAY,          // locality/stop-name lookup — changes with the timetable at most
  locality: 30 * DAY,        // stops in a locality — static between timetable seasons
  stopServices: 7 * DAY,     // routes calling at a stop — reshuffles on timetable change
  serviceStops: 14 * DAY,    // stops along a route — big page, only changes with the timetable
  directions: 1 * DAY,       // route→terminus per stop, derived from live windows — daily refresh
  departures: 20 * 1000,     // live
  nearby: 7 * DAY,
}
const SLUG_RE = /^[0-9a-z][0-9a-z-]{0,80}$/

const cacheDb = process.env.CACHE_DB
if (cacheDb) {
  try {
    mkdirSync(path.dirname(cacheDb), { recursive: true })
  } catch {
    /* read-only mount — cache falls back to memory */
  }
}
const cache = createCache(1000, { file: cacheDb })

import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

let searchIndex = { stops: [], localities: [] }
let stopLocality = new Map() // atco -> immediate locality name
async function loadSearchIndex() {
  try {
    const gzPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'search-index.json.gz')
    const jsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'search-index.json')
    if (existsSync(jsonPath)) {
      searchIndex = JSON.parse(await readFile(jsonPath, 'utf8'))
    } else if (existsSync(gzPath)) {
      const chunks = []
      await pipeline(createReadStream(gzPath), createGunzip(), async (source) => {
        for await (const chunk of source) chunks.push(chunk)
      })
      searchIndex = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
    const map = new Map()
    for (const st of searchIndex.stops || []) {
      const loc = st.c?.[0]
      if (st.a && loc) map.set(st.a, loc)
    }
    stopLocality = map
  } catch (err) {
    console.error('failed to load search index', err)
    searchIndex = { stops: [], localities: [] }
    stopLocality = new Map()
  }
}
loadSearchIndex()

async function externalCached(key, parse, makeUrl, ttlMs) {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const text = await fetchExternal(makeUrl())
  const result = { __parsed: parse(text) }
  cache.set(key, result, ttlMs)
  return result
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(data)
}

function badRequest(res, message) {
  json(res, 400, { error: message })
}

async function upstreamCached(key, parse, makePath, ttlMs) {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const html = await fetchUpstream(makePath())
  const result = { __parsed: parse(html) }
  cache.set(key, result, ttlMs)
  return result
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

async function serveStatic(req, res) {
  if (!existsSync(DIST)) return false
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (urlPath === '/') urlPath = '/index.html'
  let filePath = path.join(DIST, urlPath)
  if (!filePath.startsWith(DIST)) return false
  let body
  try {
    if (statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html')
    body = await readFile(filePath)
  } catch {
    return false
  }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  res.end(body)
  return true
}

async function serveSpaFallback(req, res) {
  const filePath = path.join(DIST, 'index.html')
  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const t0 = Date.now()
  res.on('finish', () => {
    console.log(`${req.method} ${url.pathname}${url.search.slice(0, 80)} -> ${res.statusCode} (${Date.now() - t0}ms) client=${req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-'}`)
  })


  if (url.pathname === '/api/search-all') {
    const q = (url.searchParams.get('q') || '').trim()
    if (!q) return badRequest(res, 'missing q')
    try {
      const ql = q.toLowerCase()
      const words = ql.split(/\s+/).filter(Boolean)
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
      const results = []
      const seen = new Set()

      function scoreLocality(l) {
        const name = String(l.n || l.name || '').toLowerCase()
        const ctx = (l.c || []).join(' ').toLowerCase()
        let sc = 0
        if (name === ql) sc = 200
        else if (name.startsWith(ql)) sc = 120
        else if (ctx === ql) sc = 100
        else if (name.includes(ql)) sc = 60
        else if (ctx.includes(ql)) sc = 30
        return sc
      }
      for (const l of searchIndex.localities || []) {
        const sc = scoreLocality(l)
        if (sc <= 0) continue
        if (seen.has('l:' + l.s)) continue
        seen.add('l:' + l.s)
        results.push({ type: 'locality', slug: l.s, name: l.n || l.name, qualifier: l.qualifier || null, ctx: l.c, score: sc })
        if (results.length >= limit * 2) break
      }
      function scoreStop(st) {
        const label = String(st.l || st.label || '').toLowerCase()
        const ctx = (st.c || []).join(' ').toLowerCase()
        const loc = String(st.loc || '').toLowerCase()
        const tokens = words
        let sc = 0
        if (tokens.every((w) => label.includes(w) || ctx.includes(w))) {
          if (label === ql) sc = 180
          else if (label.includes(ql)) sc = 150
          else sc = 80
        } else {
          return 0
        }
        return sc
      }
      for (const st of searchIndex.stops || []) {
        const sc = scoreStop(st)
        if (sc <= 0) continue
        const key = 's:' + st.a + ':' + (st.slug || '')
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          type: 'stop',
          atco: st.a,
          label: st.l || st.label,
          name: st.l || st.label,
          slug: st.slug,
          ctx: st.c,
          loc: st.loc,
          score: sc,
        })
      }
      results.sort((a, b) => b.score - a.score)
      return json(res, 200, { results: results.slice(0, limit), query: q })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim()
    if (!q) return badRequest(res, 'missing q')
    try {
      const words = q.split(/\s+/).filter(Boolean)
      let localities = []
      let used = q
      for (let n = words.length; n > 0 && !localities.length; n--) {
        used = words.slice(0, n).join(' ')
        const key = `s:${used.toLowerCase()}`
        const { __parsed } = await upstreamCached(key, parseSearch, () => `/search?q=${encodeURIComponent(used)}`, TTL.search)
        localities = __parsed
      }
      return json(res, 200, { localities, query: used, note: used !== q ? `No exact match for “${q}” — showing “${used}”.` : null })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/locality') {
    const slug = (url.searchParams.get('slug') || '').trim()
    if (!slug) return badRequest(res, 'missing slug')
    const key = `l:${slug}`.toLowerCase()
    try {
      const { __parsed } = await upstreamCached(key, parseLocality, () => `/localities/${encodeURIComponent(slug)}`, TTL.locality)
      return json(res, 200, { slug, ...__parsed })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/stop-services') {
    const atco = (url.searchParams.get('atco') || '').trim()
    if (!atco) return badRequest(res, 'missing atco')
    const key = `ss:${atco}`
    try {
      const { __parsed } = await upstreamCached(
        key, parseStopServices, () => `/stops/${encodeURIComponent(atco)}`, TTL.stopServices
      )
      return json(res, 200, { atco, ...__parsed })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/service-stops') {
    const slug = (url.searchParams.get('slug') || '').trim()
    if (!SLUG_RE.test(slug)) return badRequest(res, 'missing/invalid slug')
    const key = `sv:${slug}`
    try {
      const { __parsed } = await upstreamCached(
        key, parseServiceStops, () => `/services/${encodeURIComponent(slug)}`, TTL.serviceStops
      )
      const directions = (__parsed?.directions || []).map((d) => ({
        ...d,
        stops: (d.stops || []).map((s) => ({ ...s, locality: stopLocality.get(s.atco) || null })),
      }))
      return json(res, 200, { slug, ...__parsed, directions })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/departures') {
    const atco = (url.searchParams.get('atco') || '').trim()
    if (!atco) return badRequest(res, 'missing atco')
    const key = `d:${atco}`
    try {
      const { __parsed } = await upstreamCached(key, parseDepartures, () => `/stops/${encodeURIComponent(atco)}`, TTL.departures)
      if (!__parsed) return json(res, 200, { atco, departures: [] })
      return json(res, 200, { atco, ...__parsed })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/locality-directions') {
    const slug = (url.searchParams.get('slug') || '').trim()
    if (!slug) return badRequest(res, 'missing slug')
    const key = `ld:${slug}`.toLowerCase()
    try {
      const cached = cache.get(key)
      if (cached?.__parsed) return json(res, 200, { slug, directions: cached.__parsed })

      const { __parsed: parsed } = await upstreamCached(
        `l:${slug}`.toLowerCase(), parseLocality, () => `/localities/${encodeURIComponent(slug)}`, TTL.locality
      )
      if (!parsed?.stops?.length) return json(res, 200, { slug, directions: {} })

      const dirs = {}
      for (const s of parsed.stops) {
        try {
          const { __parsed: dep } = await upstreamCached(
            `d:${s.atco}`, parseDepartures, () => `/stops/${encodeURIComponent(s.atco)}`, TTL.departures
          )
          const lines = {}
          for (const d of dep?.departures || []) {
            if (!d.line || !d.destination) continue
            ;(lines[d.line] ??= new Set()).add(d.destination)
          }
          const out = {}
          for (const [line, ds] of Object.entries(lines)) out[line] = [...ds].filter(Boolean)
          if (Object.keys(out).length) dirs[s.atco] = out
        } catch {
          /* stop fetch failed — skip it (compass arrow still present) */
        }
      }

      cache.set(key, { __parsed: dirs }, TTL.directions)
      return json(res, 200, { slug, directions: dirs })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname === '/api/nearby') {
    const lat = Number(url.searchParams.get('lat'))
    const lon = Number(url.searchParams.get('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return badRequest(res, 'missing/invalid lat/lon')
    }
    const key = `nb:${lat.toFixed(4)},${lon.toFixed(4)}`
    try {
      const { __parsed } = await externalCached(
        key,
        parseNearby,
        () =>
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&accept-language=en`,
        TTL.nearby
      )
      return json(res, 200, { lat, lon, ...__parsed })
    } catch (err) {
      return json(res, 502, { error: String(err && err.message || err) })
    }
  }

  if (url.pathname.startsWith('/api/')) return badRequest(res, 'unknown endpoint')

  if (await serveStatic(req, res)) return
  await serveSpaFallback(req, res)
})

server.listen(PORT, () => {
  console.log(`whichbus server on :${PORT} (static: ${existsSync(DIST) ? 'dist' : 'none'})`)
})