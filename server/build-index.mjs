// Build the search index from the DfT NaPTAN + NPTG national datasets.
//
//   NaPTAN  https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv
//   NPTG    https://naptan.api.dft.gov.uk/v1/nptg/localities
//
// One download each, no auth, no rate limit, Open Government Licence v3.
// NaPTAN gives every GB stop: ATCOCode (the id bustimes.org uses in
// /stops/<atco>), the NaptanCode alias, name, lat/long and NPTG locality code.
// NPTG gives the localities themselves, so places with no stops still appear.
//
// Scope is Great Britain only — Northern Ireland is not in NaPTAN/NPTG (and is
// not enumerable via bustimes.org's locality hierarchy either).
//
// Output shape (read by /api/search-all and /api/stop-ctx):
//   { builtAt, localities: [{ s, n, c, qualifier? }],
//                 stops:      [{ a, na, l, s, c, x, y }] }
// `a` = ATCO (default upstream key), `na` = NaptanCode alias, `x`/`y` =
// longitude/latitude, `c` = breadcrumb ["<locality>", "<parent>", "<area>"],
// so c[0] is the stop's own locality (also used to enrich route stop lists).

import { createGzip } from 'node:zlib'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv'
const NPTG_URL = 'https://naptan.api.dft.gov.uk/v1/nptg/localities'
const UA = 'three-at-once/0.1 (+https://github.com/plmeister/three-at-once)'

// The downloaded datasets are cached here (NaPTAN is ~100 MB; re-fetched daily).
const DATA_DIR = process.env.WB_DATA_DIR || path.join(SERVER_DIR, '..', 'data')
const DATA_TTL_MS = Number(process.env.WB_DATA_TTL_HOURS || 24) * 60 * 60 * 1000

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Minimal streaming RFC4180 CSV reader: async-iterates rows of string fields,
// handling quoted fields (embedded commas/newlines) and CRLF.
async function* parseCsv(source) {
  const dec = new TextDecoder('utf-8')
  let field = ''
  let row = []
  let inQuotes = false
  for await (const chunk of source) {
    const s = dec.decode(chunk, { stream: true })
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
        } else field += ch
      } else if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        row.push(field); field = ''
      } else if (ch === '\n') {
        row.push(field); field = ''
        yield row; row = []
      } else if (ch !== '\r') {
        field += ch
      }
    }
  }
  field += dec.decode()
  if (field.length || row.length) { row.push(field); yield row }
}

function headerIndex(header) {
  const idx = new Map()
  header.forEach((name, i) => idx.set(name.trim().replace(/^\uFEFF/, ''), i))
  return idx
}

// Download to a cached file unless a recent copy already exists.
async function ensureCsv(url, file, log) {
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DATA_TTL_MS) {
    log(`cached ${path.basename(file)} (${(statSync(file).size / 1e6).toFixed(1)} MB)`)
    return
  }
  log(`downloading ${url}`)
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
  await rename(tmp, file)
  log(`saved ${path.basename(file)} (${(statSync(file).size / 1e6).toFixed(1)} MB)`)
}

// NPTG → locality table + code index. `c` is the display breadcrumb.
async function loadNptg(log) {
  const file = path.join(DATA_DIR, 'nptg-localities.csv')
  await ensureCsv(NPTG_URL, file, log)
  const localities = []
  const byCode = new Map()
  const usedSlugs = new Set()
  let header = null
  let rows = 0
  for await (const row of parseCsv(createReadStream(file))) {
    if (!header) { header = headerIndex(row); continue }
    const code = row[header.get('NptgLocalityCode')]
    const name = (row[header.get('LocalityName')] || '').trim()
    if (!code || !name) continue
    const qualifier = (row[header.get('QualifierName')] || '').trim() || null
    const parent = (row[header.get('ParentLocalityName')] || '').trim() || null
    let s = slugify(name)
    if (usedSlugs.has(s)) s = slugify(`${name} ${qualifier || parent || code}`)
    const base = s
    let n = 2
    while (usedSlugs.has(s)) s = `${base}-${n++}`
    usedSlugs.add(s)
    const c = [name, parent, qualifier].filter((v, i, a) => v && a.indexOf(v) === i)
    const entry = { s, n: name, c, qualifier }
    localities.push(entry)
    byCode.set(code, entry)
    rows++
  }
  log(`NPTG: ${rows} localities`)
  return { localities, byCode }
}

// NaPTAN → stops (active bus/coach), joined to NPTG localities.
async function loadNaptan(log, nptg) {
  const file = path.join(DATA_DIR, 'naptan.csv')
  await ensureCsv(NAPTAN_URL, file, log)
  const stops = []
  const usedSlugs = new Set(nptg.localities.map((l) => l.s))
  const synthesized = new Map() // locality name → entry, for NaPTAN codes missing from NPTG
  let header = null
  let rows = 0
  for await (const row of parseCsv(createReadStream(file))) {
    if (!header) { header = headerIndex(row); continue }
    if (row[header.get('StopType')] !== 'BCT') continue
    if (row[header.get('Status')] !== 'active') continue
    const a = (row[header.get('ATCOCode')] || '').trim()
    if (!a) continue
    const locCode = (row[header.get('NptgLocalityCode')] || '').trim()
    const locName = (row[header.get('LocalityName')] || '').trim()
    let loc = locCode ? nptg.byCode.get(locCode) : null
    if (!loc && locName) {
      loc = synthesized.get(locName)
      if (!loc) {
        let s = slugify(locName) || `loc-${synthesized.size}`
        while (usedSlugs.has(s)) s = `${s}-x`
        usedSlugs.add(s)
        loc = { s, n: locName, c: [locName], qualifier: null }
        synthesized.set(locName, loc)
        if (locCode) nptg.byCode.set(locCode, loc)
      }
    }
    const na = (row[header.get('NaptanCode')] || '').trim()
    const lon = Number(row[header.get('Longitude')])
    const lat = Number(row[header.get('Latitude')])
    const stop = { a, l: (row[header.get('CommonName')] || '').trim(), s: loc?.s || null, c: loc?.c || [] }
    if (na) stop.na = na
    if (Number.isFinite(lon) && Number.isFinite(lat)) { stop.x = lon; stop.y = lat }
    stops.push(stop)
    rows++
  }
  log(`NaPTAN: ${rows} active bus stops`)
  return { stops, extraLocalities: [...synthesized.values()] }
}

/**
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 */
export async function buildIndex({ log = () => {} } = {}) {
  const nptg = await loadNptg(log)
  const { stops, extraLocalities } = await loadNaptan(log, nptg)
  const localities = [...nptg.localities, ...extraLocalities]
  log(`done: ${localities.length} localities, ${stops.length} stops`)
  return { builtAt: new Date().toISOString(), localities, stops }
}

export async function writeIndexGz(index, outPath) {
  const tmp = `${outPath}.tmp`
  const json = JSON.stringify({ builtAt: index.builtAt, localities: index.localities, stops: index.stops })
  await pipeline(Readable.from([json]), createGzip({ level: 9 }), createWriteStream(tmp))
  await rename(tmp, outPath)
  return json.length
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : path.join(SERVER_DIR, 'search-index.json.gz')
  const t0 = Date.now()
  const index = await buildIndex({ log: (m) => console.log(`[index] ${m}`) })
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
