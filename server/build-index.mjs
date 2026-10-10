// Build the search index by walking bustimes.org's place hierarchy:
//
//   region  →  area  →  (district)  →  locality  →  stops
//
// Output is the shape /api/search-all reads:
//   { builtAt, localities: [{ s, n, c }], stops: [{ a, l, s, c }] }
// where c is the breadcrumb ["<locality>", "<area>", "<region>"], so c[0] is the
// stop's own locality (also used to enrich route stop lists).
//
// Requests are throttled by scrape.mjs (UPSTREAM_GAP_MS, default 300ms): a full
// GB build is ~15k requests and takes the better part of an hour. Run manually
// (`npm run build:index`), or let the server refresh a stale index in the
// background. Test a single region with `--region Y`.

import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchUpstream, parseLocality } from './scrape.mjs'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))

// Fallback if the homepage ever changes shape — codes bustimes uses for regions.
const FALLBACK_REGIONS = [
  'CO', 'EA', 'EM', 'GB', 'IM', 'L', 'LE', 'MU', 'NE', 'NI', 'NW', 'S', 'SE', 'SW', 'UL', 'W', 'WM', 'Y',
]

function links(html, re) {
  const out = new Set()
  for (const m of html.matchAll(re)) out.add(m[1])
  return [...out]
}

function breadcrumb(html) {
  const m = html.match(/<ol class="breadcrumb"[^>]*>([\s\S]*?)<\/ol>/)
  if (!m) return []
  return [...m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
    .map((li) => li[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter((name) => name && name.toLowerCase() !== 'home')
}

function pageTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : ''
}

async function discoverRegions() {
  try {
    const html = await fetchUpstream('/')
    const found = links(html, /href="\/regions\/([A-Za-z0-9]+)"/g)
    return found.length ? found : FALLBACK_REGIONS
  } catch {
    return FALLBACK_REGIONS
  }
}

// Breadth-first walk of the place hierarchy, collecting every locality slug.
// Intermediate nodes vary by region (some list areas, London lists districts,
// some list localities directly), so any /areas or /districts link is queued
// and any /localities link is collected. A visited set bounds the crawl.
async function collectLocalitySlugs(regionCodes, { log, failures }) {
  const get = async (p) => {
    try {
      return await fetchUpstream(p)
    } catch (err) {
      failures.push({ path: p, error: String(err?.message || err) })
      return null
    }
  }
  const visited = new Set()
  const slugs = new Set()
  const queue = regionCodes.map((code) => `/regions/${code}`)
  let pages = 0
  while (queue.length) {
    const p = queue.shift()
    if (visited.has(p)) continue
    visited.add(p)
    const html = await get(p)
    if (!html) continue
    if (++pages % 100 === 0) log(`${p}: ${slugs.size} localities, ${queue.length} queued`)
    for (const slug of links(html, /href="\/localities\/([0-9a-z-]+)"/g)) slugs.add(slug)
    for (const area of links(html, /href="\/areas\/(\d+)"/g)) if (!visited.has(`/areas/${area}`)) queue.push(`/areas/${area}`)
    for (const d of links(html, /href="\/districts\/(\d+)"/g)) if (!visited.has(`/districts/${d}`)) queue.push(`/districts/${d}`)
  }
  log(`scanned ${visited.size} place pages, found ${slugs.size} localities`)
  return slugs
}

/**
 * @param {object} [opts]
 * @param {string[]|null} [opts.regionCodes]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.logEvery]
 * @param {boolean} [opts.discoverOnly]
 */
export async function buildIndex({ regionCodes = null, log = () => {}, logEvery = 500, discoverOnly = false } = {}) {
  const failures = []
  const regions = regionCodes?.length ? regionCodes : await discoverRegions()
  log(`building index for ${regions.length} region(s): ${regions.join(', ')}`)

  const slugs = await collectLocalitySlugs(regions, { log, failures })
  if (discoverOnly) return { builtAt: new Date().toISOString(), localities: [], stops: [], slugs: [...slugs], failures }
  log(`found ${slugs.size} localities — fetching stops`)

  const localities = []
  const stops = []
  const seenAtco = new Set()
  let done = 0
  for (const slug of slugs) {
    let html
    try {
      html = await fetchUpstream(`/localities/${encodeURIComponent(slug)}`)
    } catch (err) {
      failures.push({ path: `/localities/${slug}`, error: String(err?.message || err) })
      continue
    }
    const name = pageTitle(html) || slug.replace(/-/g, ' ')
    const c = [name, ...breadcrumb(html)]
    localities.push({ s: slug, n: name, c })
    const parsed = parseLocality(html)
    for (const st of parsed.stops || []) {
      if (!st.atco || seenAtco.has(st.atco)) continue
      seenAtco.add(st.atco)
      stops.push({ a: st.atco, l: st.label, s: slug, c })
    }
    if (++done % logEvery === 0) log(`${done}/${slugs.size} localities, ${stops.length} stops, ${failures.length} failures`)
  }

  log(`done: ${localities.length} localities, ${stops.length} stops, ${failures.length} failures`)
  return { builtAt: new Date().toISOString(), localities, stops, failures }
}

export async function writeIndexGz(index, outPath) {
  const tmp = `${outPath}.tmp`
  const json = JSON.stringify({ builtAt: index.builtAt, localities: index.localities, stops: index.stops })
  await pipeline(Readable.from([json]), createGzip({ level: 9 }), createWriteStream(tmp))
  await rename(tmp, outPath)
  return json.length
}

function parseArgs(argv) {
  const out = { regionCodes: null, outPath: path.join(SERVER_DIR, 'search-index.json.gz'), logEvery: 500, discoverOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--region' || a === '--regions') out.regionCodes = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--out') out.outPath = path.resolve(argv[++i])
    else if (a === '--log-every') out.logEvery = Number(argv[++i]) || 500
    else if (a === '--discover-only') out.discoverOnly = true
  }
  return out
}

async function main() {
  const { regionCodes, outPath, logEvery, discoverOnly } = parseArgs(process.argv.slice(2))
  const t0 = Date.now()
  const index = await buildIndex({ regionCodes, logEvery, discoverOnly, log: (m) => console.log(`[index] ${m}`) })
  if (discoverOnly) {
    console.log(`discovered ${index.slugs.length} localities in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    return index
  }
  const bytes = await writeIndexGz(index, outPath)
  console.log(`wrote ${outPath} (${(bytes / 1e6).toFixed(1)} MB raw, ${index.stops.length} stops) in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  return index
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}

