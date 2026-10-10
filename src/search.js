import { searchLocalities, searchAll, localityStops, localityDirections, nearby, stopDepartures, stopServices } from './api.js'
import { getState, getFavourites, removeFavourite, getGroups, resolveGroup } from './store.js'
import { stopDirProfile, bestSharedLeg } from './routes.js'
import { escapeHtml } from './html.js'

let active = false
let onPick = null
let slate = [] // displayed list items
let allSlate = [] // full list for the current browse level
let browsing = null // { slug, name } when drilling into a locality
let dirMap = null // atco -> { line: [destinations] } route-direction labels
let favMine = 0 // generation counter: invalidates in-flight favourite mining

const dialog = () => /** @type {HTMLDialogElement} */ (document.getElementById('search-dialog'))
const input = () => /** @type {HTMLInputElement} */ (document.getElementById('search-input'))
const results = () => /** @type {HTMLElement} */ (document.getElementById('search-results'))
const hint = () => document.getElementById('search-hint')
const back = () => document.getElementById('search-back')

const DEST_HINT = 'Where are you going? Pick the stop you’d arrive at.'
const ORIGIN_HINT = 'Where will you be picked up? Pick the stop you leave from.'

/** @type {ReturnType<typeof setTimeout>|0} */
let debounce = 0

export function openSearch(pick, mode = 'origin') {
  onPick = pick
  active = true
  slate = []
  dialog().dataset.mode = mode
  resetToPlaces()
  document.getElementById('search-close').textContent = '×'
  dialog().showModal()
  input().value = ''
  input().focus()
}

function hintText() {
  return dialog().dataset.mode === 'to' ? DEST_HINT : ORIGIN_HINT
}

function resetToPlaces() {
  favMine++
  back().hidden = true
  hint().hidden = false
  results().hidden = false
  document.getElementById('map-pane').hidden = true
  hint().textContent = hintText()
  results().replaceChildren()
  browsing = null
  allSlate = []
  dirMap = null
  document.getElementById('locate-btn').hidden = dialog().dataset.mode !== 'origin'
  renderFavourites()
}

function renderFavourites() {
  const groups = getGroups()
  const favs = getFavourites()
  if (!groups.length && !favs.length) return
  const frag = document.createDocumentFragment()
  for (const g of groups) {
    const resolved = resolveGroup(g)
    const count = resolved?.stops.length || 0
    const li = document.createElement('li')
    li.className = 'result fav-result custom-group'
    li.innerHTML = `<span class="r-icon">🏷</span><span class="r-main">${escapeHtml(g.name)}<small class="r-lines">my group · ${count} stop${count === 1 ? '' : 's'}</small></span><span class="r-cta">＋</span>`
    li.addEventListener('click', () => onPick?.(resolved))
    frag.appendChild(li)
  }
  for (const [i, f] of favs.entries()) {
    const li = document.createElement('li')
    li.className = 'result fav-result'
    li.dataset.fav = i
    const glyph = f.kind === 'group' ? '🏛' : '🚏'
    li.innerHTML = `<span class="r-icon">★</span><span class="r-main">${escapeHtml(f.label)}<small class="r-lines">favourite · ${fvLines(f)}</small></span><span class="r-cta r-x" data-fav="${i}">✕</span>`
    li.addEventListener('click', (e) => {
      if (/** @type {Element} */ (e.target).closest('.r-x')) {
        removeFavourite(f)
        resetToPlaces()
        return
      }
      onPick?.(f)
    })
    frag.appendChild(li)
  }
  results().appendChild(frag)
  mineFavDestinations().catch(() => {})
}

function fvLines(f) {
  const n = f.kind === 'group' ? `${f.stops.length} stops` : (f.atco || '')
  return n || '—'
}

async function search() {
  clearTimeout(debounce)
  const q = input().value.trim()
  results().classList.add('pending')
  if (!q) {
    if (browsing) {
      slate = allSlate
      results().replaceChildren()
      renderList()
      hint().textContent = `Browsing stops in ${browsing.name} — type to narrow them.`
    } else {
      slate = []
      allSlate = []
      resetToPlaces()
    }
    results().classList.remove('pending')
    return
  }
  if (browsing) {
    const w = q.toLowerCase()
    slate = allSlate.filter((it) => itemMatches(it, w))
    results().replaceChildren()
    renderList()
    hint().textContent = slate.length
      ? `${slate.length} of ${allSlate.length} stops match “${q}”${slate.length < allSlate.length ? ' — keep typing or clear to see all.' : ''}`
      : `No stops in ${browsing.name} match “${q}”.`
    results().classList.remove('pending')
    return
  }
   debounce = setTimeout(async () => {
     hint().textContent = `Searching “${q}”…`
     try {
       const res = await searchAll(q, 40)
       const items = groupSearchResults(res)
       allSlate = items
       slate = items
       renderList()
       if (items.length === 0) hint().textContent = `No matches for “${q}”. Try a shorter name — “Kingswood”, “Grimsby”, “Sculcoates”.`
       else hint().textContent = `${items.length} result${items.length === 1 ? '' : 's'} for “${q}”.`
     } catch (err) {
       console.error('search failed', err)
       const detail = err && err.message ? err.message : String(err)
       results().replaceChildren()
       results().insertAdjacentHTML('afterbegin', `<li class="empty error">Search failed${detail ? ` (${escapeHtml(detail.slice(0, 60))})` : ''}. <button type="button" class="retry">Retry</button></li>`)
       results().querySelector('.retry')?.addEventListener('click', search)
       hint().textContent = ''
     } finally {
       results().classList.remove('pending')
     }
   }, 200)
}

function applyDirections(directions) {
  dirMap = directions
  stampDirs()
}

function stampDirs() {
  if (!dirMap) return
  for (const row of results().querySelectorAll('.result.stop-result[data-atco]')) {
    const d = dirMap[/** @type {HTMLElement} */ (row).dataset.atco]
    if (!d || row.querySelector('.r-dir')) continue
    const dests = [...new Set(Object.values(d).flat())].filter(Boolean)
    if (!dests.length) continue
    row.querySelector('.r-main')?.insertAdjacentHTML(
      'beforeend',
      `<small class="r-dir">→ ${escapeHtml(dests.join(' · '))}</small>`
    )
  }
}

function itemMatches(it, w) {
  if (it.type === 'group') {
    const bits = [it.label].concat((it.stops || []).map((s) => s.label)).join(' ')
    return bits.toLowerCase().includes(w)
  }
  return String(it.label || '').toLowerCase().includes(w)
}

// "same street, opposite kerbs": "Cottingham King Street ↑" / "… ↓", and the
// dominant bustimes form "Park Street (nr) ↑" / "Park Street (opp) ↓". One place
// to stand, not two — collapse them so the board shows the route both ways and
// the destination filter picks the right side.
const ARROW_STOP_RE = /^(.*?)\s*[↑↓←→↗↘↙↖↕]\s*$/

// A trailing parenthetical only strips when it qualifies *which* stop at a place
// we already know: a bay/stand/gate, a side of the road, a direction, a stand
// letter. Never when it names a different place — "Tarbert (Harris)" is not
// "Tarbert (Loch Fyne)", "Leixlip(Confey)" is not "Leixlip(Louisa Bridge)".
const Q_ID = '(?:[A-Z]{1,2}\\d{0,3}|\\d{1,3}[A-Z]?|[A-Z])'
const Q_KW = '(?:bay|stand|gate|stance|stop|platform|halt|entrance|arrivals?|arrival\\s+bay)'
const Q_REL = '(?:opp|opposite|adj|adjacent|at|before|after|nr|near|o/s|outside|by|cnr|corner|in|on|across|just\\s+before|just\\s+after)'
const Q_BND = '(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)[-\\s]?bound|inbound|outbound|northbound|southbound|eastbound|westbound)'
const SUFFIX_PAREN_RE = new RegExp(
  `^(?:${Q_KW}\\s*-\\s*${Q_KW}\\s*${Q_ID}|${Q_KW}\\s*${Q_ID}|${Q_REL}\\s*${Q_ID}|${Q_KW}|${Q_REL}|${Q_BND}|${Q_ID})$`,
  'i'
)

function stripStopSuffixes(label) {
  let s = String(label ?? '').trim()
  let m = s.match(ARROW_STOP_RE)
  if (m) s = m[1].trim()
  let guard = 0
  while (guard++ < 6 && (m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/))) {
    const base = m[1].trim()
    if (base.length >= 3 && SUFFIX_PAREN_RE.test(m[2].trim())) s = base
    else break
  }
  // on-street lettered stands: "George Street A", "Swansea Bus Station Stand A".
  // Single letter or letter+digit only, so an acronym in the name survives
  // ("O'Connell - GPO").
  m = s.match(/^(.*?)\s+[A-Z]\d{0,2}$/)
  if (m && m[1].trim().length >= 3) s = m[1].trim()
  return s
}

function stemOfLabel(label) {
  const s = stripStopSuffixes(label)
  return s.length >= 3 ? s.toLowerCase() : null
}

// "(Bay 10)" / "F ←" / "↑" are suffixes on one place, not part of its name.
function groupLabel(label) {
  return stripStopSuffixes(label) || String(label ?? '').trim()
}

const DIR_ORDER = ['↑', '↓', '→', '←', '↗', '↘', '↙', '↖', '↕', '']
const DIR_NAMES = {
  '↑': 'Northbound', '↓': 'Southbound', '→': 'Eastbound', '←': 'Westbound',
  '↗': 'North-east', '↘': 'South-east', '↙': 'South-west', '↖': 'North-west',
  '↕': 'North / South', '': 'Direction unknown',
}

function arrowDir(label) {
  const m = String(label || '').match(/([↑↓←→↗↘↙↖↕])$/)
  return m ? m[1] : ''
}

function groupStops(stops) {
  const buckets = new Map() // stem -> members
  const plain = []
  for (const s of stops) {
    const stem = stemOfLabel(s.label)
    if (stem) {
      const arr = buckets.get(stem) || []
      arr.push(s)
      buckets.set(stem, arr)
    } else {
      plain.push(s)
    }
  }
  // fold in stops whose label is exactly the stem (e.g. "Hull Interchange")
  for (const s of plain.filter((x) => buckets.has(groupLabel(x.label).toLowerCase()))) {
    buckets.get(groupLabel(s.label).toLowerCase()).push(s)
  }
  const cards = []
  const singles = []
  for (const [stem, members] of buckets) {
    if (members.length < 2) {
      singles.push({ ...members[0], type: 'stop' })
      continue
    }
    cards.push({
      type: 'group',
      kind: 'group',
      label: groupLabel(members[0].label),
      stops: members.map(({ atco, label, lines }) => ({ atco, label, lines: lines || [] })),
      lines: [...new Set(members.flatMap((s) => s.lines || []))],
    })
  }
  const folded = new Set(plain.filter((x) => buckets.has(groupLabel(x.label).toLowerCase())))
  for (const s of plain) if (!folded.has(s)) singles.push({ ...s, type: 'stop' })

  // bucket the standalone (non-grouped) stops by the compass arrow in the label
  const byDir = new Map()
  for (const s of singles) {
    const d = arrowDir(s.label)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(s)
  }
  const out = []
  for (const dir of DIR_ORDER) {
    const list = byDir.get(dir)
    if (!list) continue
    if (list.length >= 2) out.push({ type: 'dir', label: DIR_NAMES[dir] })
    out.push(...list.sort((a, b) => a.label.localeCompare(b.label)))
  }
  out.push(...cards.sort((a, b) => a.label.localeCompare(b.label)))
  return out
}

// Search hits arrive as a flat ranked list of stops + localities. Collapse stops
// that share a stem ("Rail Station (Stop RA) ↑" …) into one group card, keeping
// the best-ranked member's position, so searching "york station" surfaces the
// group rather than ten anonymous stop rows. Localities pass through untouched.
export function groupSearchResults(res) {
  const out = []
  for (const [i, r] of (res || []).entries()) {
    if (r.type === 'locality') {
      out.push({ order: i, item: { type: 'locality', slug: r.slug, name: r.name, qualifier: r.qualifier, ctx: r.ctx } })
    }
  }
  const groups = new Map()
  const singles = []
  for (const [i, r] of (res || []).entries()) {
    if (r.type !== 'stop') continue
    const item = {
      type: 'stop',
      atco: r.atco,
      label: r.label || r.name,
      name: r.label || r.name,
      slug: r.slug,
      ctx: r.ctx,
      lines: [],
    }
    const stem = stemOfLabel(item.label)
    if (stem) {
      if (!groups.has(stem)) groups.set(stem, { order: i, members: [] })
      groups.get(stem).members.push(item)
    } else {
      singles.push({ order: i, item })
    }
  }
  for (const [, g] of groups) {
    if (g.members.length >= 2) out.push({ order: g.order, item: searchGroupCard(g.members) })
    else out.push({ order: g.order, item: g.members[0] })
  }
  out.push(...singles)
  out.sort((a, b) => a.order - b.order)
  return out.map((x) => x.item)
}

function searchGroupCard(members) {
  return {
    type: 'group',
    kind: 'group',
    label: groupLabel(members[0].label),
    stops: members.map((m) => ({ atco: m.atco, label: m.label, lines: m.lines || [] })),
    lines: [...new Set(members.flatMap((m) => m.lines || []))],
    ctx: members[0].ctx,
    slug: members[0].slug,
  }
}

function crumbsHTML(ctx, firstSlug) {
  const names = [...new Set((ctx || []).map((c) => String(c ?? '').trim()).filter(Boolean))]
  if (!names.length) return ''
  return (
    '<small class="r-crumb">' +
    names
      .map((n, i) => {
        const slug = i === 0 && firstSlug ? ` data-slug="${escapeHtml(firstSlug)}"` : ''
        return `<button type="button" class="crumb" data-crumb="${escapeHtml(n)}"${slug}>${escapeHtml(n)}</button>`
      })
      .join('<span class="crumb-sep">›</span>') +
    '</small>'
  )
}

function renderList() {
  results().replaceChildren()
  if (!slate.length) return
  const frag = document.createDocumentFragment()
  for (const item of slate) {
    const li = document.createElement('li')
    li.className = 'result'
    li.setAttribute('role', 'option')
    if (item.indent) li.classList.add('sub')
    if (item.type === 'dir') {
      li.className = 'result dir'
      li.innerHTML = `<span class="r-icon">🧭</span><span class="r-main">${escapeHtml(item.label)}</span><span class="r-cta"></span>`
    } else if (item.type === 'group') {
      li.className = 'result group-result'
      const uniqLines = [...new Set(item.lines || [])].join(' · ')
      li.innerHTML = `<span class="r-icon">🏛</span><span class="r-main">${escapeHtml(item.label)}${crumbsHTML(item.ctx, item.slug)}<small class="r-lines">${item.stops.length} stops${uniqLines ? ` · ${escapeHtml(uniqLines)}` : ''}</small></span><span class="r-cta">▸</span>`
      li.addEventListener('click', (e) => { if (/** @type {Element} */ (e.target).closest('.crumb')) return; onPick?.(item) })
    } else if (item.type === 'locality') {
      li.innerHTML = `<span class="r-icon">⌖</span><span class="r-main">${escapeHtml(item.name)}${item.qualifier ? ` <small>${escapeHtml(item.qualifier)}</small>` : ''}</span><span class="r-cta">›</span>`
      li.addEventListener('click', () => openLocality(item))
    } else {
      li.className = 'result stop-result'
      if (item.atco) li.dataset.atco = item.atco
      li.innerHTML = `<span class="r-icon">🚏</span><span class="r-main">${escapeHtml(item.label)}${item.lines?.length ? `<small class="r-lines">${item.lines.map(escapeHtml).join(' · ')}</small>` : ''}${crumbsHTML(item.ctx, item.slug)}</span><span class="r-cta">＋</span>`
      li.addEventListener('click', (e) => {
        if (/** @type {Element} */ (e.target).closest('.crumb')) return
        onPick?.(item)
      })
    }
    frag.appendChild(li)
  }
  results().appendChild(frag)
  stampDirs()
}

async function openLocalityByName(name, slug) {
  const place = String(name ?? '').trim()
  if (!place) return
  if (slug) {
    openLocality({ slug, name: place })
    return
  }
  try {
    const { localities = [] } = await searchLocalities(name)
    const loc = localities.find((l) => l.name?.toLowerCase() === name.toLowerCase()) || localities[0]
    if (loc) {
      openLocality(loc)
      return
    }
  } catch {
    /* fall through to a plain search */
  }
  input().value = name
  search()
}

async function openLocality(loc) {
  browsing = { slug: loc.slug, name: loc.name }
  dirMap = null
  back().hidden = false
  hint().textContent = `Browsing stops in ${loc.name} — type to narrow them.`
  results().replaceChildren()
  results().classList.add('pending')
  input().value = loc.name
  input().focus()
  try {
    const { stops } = await localityStops(loc.slug)
    allSlate = groupStops(stops.filter((s) => s.lines?.length))
    slate = allSlate
    renderList()
    if (!slate.length) {
      hint().textContent = `No bus stops found in ${loc.name}.`
      results().insertAdjacentHTML('afterbegin', '<li class="empty">Try another place.</li>')
    }
    // route-based direction labels (destinations of each stop's own departures)
    localityDirections(loc.slug)
      .then(({ directions = {} } = {}) => applyDirections(directions))
      .catch(() => {})
  } catch {
    hint().textContent = `Couldn’t load ${loc.name}.`
  } finally {
    results().classList.remove('pending')
  }
}

export function closeSearch() {
  if (active && dialog().open) dialog().close()
  active = false
}

export function initSearch() {
  const d = dialog()
  input().addEventListener('input', search)
  document.getElementById('search-close').addEventListener('click', closeSearch)
  results().addEventListener('click', (e) => {
    const crumb = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest?.('.crumb'))
    if (crumb) {
      e.stopPropagation()
      openLocalityByName(crumb.dataset.crumb, crumb.dataset.slug)
    }
  })
  back().addEventListener('click', () => {
    input().value = ''
    browsing = null
    allSlate = []
    active = true
    slate = []
    resetToPlaces()
    input().focus()
  })
  document.getElementById('tab-name').addEventListener('click', () => showTab('name'))
  document.getElementById('tab-map').addEventListener('click', () => {
    showTab('map')
    initMap()
  })
  document.getElementById('map-find').addEventListener('click', findNearPin)
  document.getElementById('locate-btn').addEventListener('click', locateMe)
  d.addEventListener('close', () => {
    active = false
  })
  d.addEventListener('click', (e) => {
    if (e.target === d) closeSearch()
  })
}

function showTab(name) {
  const named = name === 'name'
  document.getElementById('tab-name').classList.toggle('on', named)
  document.getElementById('tab-map').classList.toggle('on', !named)
  document.getElementById('search-hint').hidden = !named
  document.getElementById('search-results').hidden = !named
  document.getElementById('map-pane').hidden = named
  if (named) input().focus()
  else input().blur()
}

let map = null
let pin = null

function initMap() {
  if (map || !window.L) return
  const el = document.getElementById('osm-map')
  map = window.L.map(el).setView([53.7446, -0.3471], 15)
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)
  pin = window.L.marker([53.7446, -0.3471], { draggable: true }).addTo(map)
}

async function findNearPin() {
  const status = document.getElementById('map-status')
  const resultsEl = document.getElementById('map-results')
  if (!map || !pin) {
    status.textContent = 'Map isn’t ready.'
    return
  }
  const { lat, lng } = pin.getLatLng()
  status.textContent = 'Looking for places near the pin…'
  resultsEl.replaceChildren()
  try {
    const r = await nearby(lat.toFixed(5), lng.toFixed(5))
    for (const name of r.names || []) {
      const { localities } = await searchLocalities(name)
      const loc = localities.find((l) => l.name?.toLowerCase() === name.toLowerCase()) || localities[0]
      if (!loc) continue
      status.textContent = `Stops in ${name}`
      try {
        await renderMapStops(loc)
      } catch {
        status.textContent = `Couldn’t load stops in ${name}.`
      }
      return
    }
    status.textContent = `No places with bus stops near that point (near ${r.names?.[0] || '…'}).`
  } catch {
    status.textContent = 'Search failed — try moving the pin a little.'
  }
}

async function renderMapStops(loc) {
  const { stops } = await localityStops(loc.slug)
  const sl = groupStops(stops.filter((s) => s.lines?.length))
  const resultsEl = document.getElementById('map-results')
  resultsEl.replaceChildren()
  const items = sl.filter((it) => it.type === 'stop' || it.type === 'group')
  if (!items.length) return
  const frag = document.createDocumentFragment()
  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'result stop-result'
    const glyph = item.kind === 'group' ? '🏛' : '🚏'
    li.innerHTML = `<span class="r-icon">${glyph}</span><span class="r-main">${escapeHtml(item.label)}<small class="r-lines">${
      item.kind === 'group' ? `${item.stops.length} stops` : (item.lines || []).map(escapeHtml).join(' · ')
    }</small></span><span class="r-cta">＋</span>`
    li.addEventListener('click', () => onPick?.(item))
    frag.appendChild(li)
  }
  resultsEl.appendChild(frag)
}

// ---- destination hints from favourites (shared routes with the origin) ----

function linesOf(stop) {
  const set = new Set()
  const src = stop.kind === 'group' ? (stop.stops || []) : [stop]
  for (const s of src) for (const l of s.lines || []) if (l) set.add(l)
  return set
}

async function resolveLines(stop) {
  const set = linesOf(stop)
  if (set.size || stop.kind === 'group' || !stop.atco) return set
  try {
    const { services = [] } = await stopServices(stop.atco)
    for (const svc of services) if (svc.line) set.add(svc.line)
  } catch {
    /* leave lines as-is — route unknown means "no evidence", skip */
  }
  return set
}

async function originDepartures(origin) {
  const src = origin.kind === 'group' ? (origin.stops || []) : [origin]
  const sets = await Promise.all(
    src.map(async (s) => {
      if (!s.atco) return []
      try {
        const r = await stopDepartures(s.atco)
        return r.departures || []
      } catch {
        return []
      }
    })
  )
  return sets.flat()
}

function shortLabel(s) {
  const str = String(s ?? '')
  const m = str.match(/^([\s\S]*?)\s*\([^)]*\)$/)
  const base = m ? m[1] : str
  return base.replace(/\s*[↑↓←→↗↘↙↖↕]+\s*$/, '').trim() || str
}

// With an origin chosen, cross-reference each favourite stop against the
// origin's routes and stamp the chip with the next bus that reaches it.
async function mineFavDestinations() {
  const gen = ++favMine
  if (dialog().dataset.mode !== 'to') return
  const { origin } = getState()
  if (!origin) return
  const favs = getFavourites()
  if (!favs.length) return
  const oLines = await resolveLines(origin)
  if (gen !== favMine || !active || !oLines.size) return

  const routes = []
  for (const [i, f] of favs.entries()) {
    const fLines = await resolveLines(f)
    const shared = [...oLines].filter((l) => fLines.has(l))
    if (shared.length) routes.push({ i, f, shared: new Set(shared) })
  }
  if (gen !== favMine || !active || !routes.length) return

  const deps = await originDepartures(origin)
  if (gen !== favMine || !active) return
  for (const route of routes) {
    if (gen !== favMine || !active) return
    const destDeps = await destDepartures(route.f)
    const next = bestSharedLeg(deps, stopDirProfile(destDeps || []), route.shared)
    await stampFavChip(route, next, destDeps, gen)
  }
}

async function destDepartures(f) {
  if (f.kind === 'group' || !f.atco) return null
  try {
    const r = await stopDepartures(f.atco)
    return r.departures || []
  } catch {
    return null
  }
}

async function stampFavChip({ i, f }, next, destDeps, gen) {
  const findChip = () =>
    gen === favMine && active ? results().querySelector(`.fav-result[data-fav="${i}"]`) : null
  const chip = findChip()
  if (!chip) return
  const mainEl = chip.querySelector('.r-main')
  if (!mainEl || mainEl.querySelector('.r-mine')) return

  if (!next) {
    const from = shortLabel(getState().origin?.label)
    mainEl.insertAdjacentHTML(
      'beforeend',
      `<small class="r-mine none">no direct bus from ${escapeHtml(from)}</small>`
    )
    return
  }
  const t = next.scheduled || next.expected
  let arr = ''
  const destDep = destDeps && next.tripUrl ? destDeps.find((d) => d.tripUrl === next.tripUrl) : null
  if (destDep) {
    const at = destDep.expected || destDep.scheduled
    if (at) arr = ` <span class="r-arr">arr ${escapeHtml(at)}</span>`
  }
  const again = findChip()
  if (!again) return
  const againMain = again.querySelector('.r-main')
  if (!againMain || againMain.querySelector('.r-mine')) return
  againMain.insertAdjacentHTML(
    'beforeend',
    `<small class="r-mine">🚌 <b>${escapeHtml(next.line)}</b> ${escapeHtml(t)}${next.destination ? ` · ${escapeHtml(next.destination)}` : ''}${arr}</small>`
  )
}

// ---- "use my location": reverse-geocode → nearest locality → its stops ----

async function locateMe() {
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('locate-btn'))
  if (!('geolocation' in navigator)) {
    hint().textContent = 'Your browser doesn’t support location.'
    return
  }
  btn.disabled = true
  const oldText = btn.textContent
  btn.textContent = 'Locating…'
  hint().textContent = 'Finding stops near you…'
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 60000,
      })
    )
    const { latitude, longitude } = pos.coords
    const { names = [] } = await nearby(latitude.toFixed(6), longitude.toFixed(6))
    for (const name of names) {
      try {
        const { localities } = await searchLocalities(name)
        const loc = localities.find((l) => l.name?.toLowerCase() === name.toLowerCase()) || localities[0]
        if (loc) {
          openLocality(loc)
          return
        }
      } catch {
        /* locality lookup failed — try next name */
      }
    }
    hint().textContent = 'No place with bus stops found near you.'
  } catch (err) {
    hint().textContent = err?.code === 1 ? 'Location permission denied.' : 'Couldn’t get your location.'
  } finally {
    btn.disabled = false
    btn.textContent = oldText
  }
}
