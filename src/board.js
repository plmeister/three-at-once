import { MAX_DEPARTURES, REFRESH_MS, STALE_MS } from './config.js'
import { stopDepartures, stopServices } from './api.js'
import {
  getState, setOrigin, setDestination, setToStop, setOperator, clearOrigin,
  buildShareUrl, addFavourite, removeFavourite, isFavourite, toggleFavourite,
  getFavJourneys, isFavJourney, saveFavouriteJourney, removeFavJourney, journeyKey,
} from './store.js'
import { stopDirProfile, legVerdict, DIR } from './routes.js'
import { openSearch } from './search.js'
import { hoverRoute, leaveRoute, tapRoute, focusRoute, blurRoute } from './route-sheet.js'

let lastLoadedAt = 0
let timer = null
let onVisibleFn = null
let fetching = false
let boardState = null
let boardOrigin = null
let boardTo = null
let toInfo = null // { atco, slugs:Set|null, lines:Set, services:[] }
let toAtcos = [] // every atco behind the destination — a merged group contributes all of them
let toArrivals = null // Map<tripUrl, departure> at the destination stop
let toDir = null // stopDirProfile of the destination stop's own departures
let openToSearchFn = null // lets the destination chip reopen the picker
let replaceOriginFn = null // set by main.js so the origin panel can reopen the picker

export function setReplaceOriginHandler(fn) { replaceOriginFn = fn }
let fareOps = new Set() // operator names serving the board (origin + via destination)
let lineFilter = null // { slug, line } — narrows the board to one service
let originServices = [] // every service calling at the origin stop
let svcOpen = false // is the "services here" panel expanded?
const stopServicesCache = new Map() // atco -> services[]

function atcosOf(stop) {
  if (!stop) return []
  return stop.kind === 'group' ? stop.stops.map((s) => s.atco).filter(Boolean) : [stop.atco].filter(Boolean)
}

// Stop list for one service: which stops the route passes, and where your stop
// and destination sit on it.
function routeOpts(btn, svc) {
  const slug = btn?.dataset.route
  const { origin, toStop } = getState()
  return {
    slug,
    line: btn?.dataset.line || svc?.line || '',
    headline: svc?.headline || '',
    serviceUrl: slug ? `/services/${slug}` : null,
    fromAtcos: atcosOf(origin),
    toAtcos: atcosOf(toStop),
    anchor: btn,
  }
}

function serviceBySlug(slug) {
  return originServices.find((s) => s.slug === slug) || null
}

export function bootBoard(app, origin) {
  toInfo = null
  toArrivals = null
  toDir = null
  lineFilter = null
  originServices = []
  svcOpen = false
  boardOrigin = origin
  const el = document.createElement('section')
  el.className = 'board'
  el.innerHTML = `
    <div class="board-head">
      <div class="board-main">
        <div id="origin-panel"></div>
      </div>
      <div class="board-status">
        <button class="icon-btn" id="btn-swap" type="button" title="Swap departure point and destination (reverse direction)">⇄</button>
        <button class="icon-btn" id="btn-clear" type="button" title="Clear stops and start again">✕</button>
        <button class="icon-btn" id="btn-share" type="button" title="Copy link to this journey (share it)">⇪</button>
        <button class="icon-btn" id="btn-refresh" type="button" aria-label="Refresh now">↻</button>
        <span id="board-stamp"></span>
      </div>
    </div>

    <div class="dest-section">
      <div id="dest-panel"></div>
      <button class="to-add" id="btn-set-to" type="button">＋ Set destination…</button>
    </div>
    <button class="jfav-btn" id="btn-jfav" type="button" disabled>⭑ Name & save this journey</button>

    <form class="filter-row">
      <label for="dest-select">Show only</label>
      <select id="dest-select"></select>
      <label for="op-select">Operator</label>
      <select id="op-select"></select>
    </form>

    <div class="line-filter" id="line-filter" hidden></div>

<!-- svc-panel removed in favor of stop panels -->

    <ul class="departures" id="dep-list" aria-live="polite"></ul>
    <p class="board-foot" id="board-foot"></p>
    <p class="fare-note" id="fare-note" hidden></p>
  `
  app.replaceChildren(el)
  const st = getState()
  boardTo = st.toStop || null
  if (typeof renderStopPanel === 'function') {
    renderStopPanel('origin-panel', boardOrigin)
    if (typeof renderStopPanel === 'function') renderStopPanel('dest-panel', boardTo)
  }
  const setDestBtn = el.querySelector('#btn-set-to')
  if (setDestBtn && boardTo) setDestBtn.style.display = 'none'
  else if (setDestBtn) setDestBtn.style.display = 'inline-flex'
  ensureOriginServices().catch(() => {})


  const list = el.querySelector('#dep-list')
  const stamp = el.querySelector('#board-stamp')
  const select = el.querySelector('#dest-select')
  const opSelect = el.querySelector('#op-select')
  const refresh = el.querySelector('#btn-refresh')
  const share = el.querySelector('#btn-share')
  const jfav = el.querySelector('#btn-jfav')
  const swap = el.querySelector('#btn-swap')
  const clear = el.querySelector('#btn-clear')
  const toRow = el.querySelector('#to-row')
  const lineFilterEl = el.querySelector('#line-filter')

  // Route numbers are delegated: rows are re-rendered wholesale on every poll,
  // so per-row listeners would be thrown away every 20s.
  const routeBtn = (target) => target.closest?.('[data-route]') || null
  list.addEventListener('click', (e) => {
    const btn = routeBtn(e.target)
    if (btn) tapRoute(btn, routeOpts(btn))
  })
  list.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return
    const btn = routeBtn(e.target)
    if (btn) hoverRoute(btn, routeOpts(btn))
  })
  list.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return
    if (routeBtn(e.target)) leaveRoute()
  })
  list.addEventListener('focusin', (e) => {
    const btn = routeBtn(e.target)
    if (btn) focusRoute(btn, routeOpts(btn))
  })
  list.addEventListener('focusout', (e) => {
    if (routeBtn(e.target)) blurRoute()
  })


  lineFilterEl.addEventListener('click', (e) => {
    const go = e.target.closest('[data-route]')
    if (go) {
      tapRoute(go, routeOpts(go, serviceBySlug(go.dataset.route)))
      return
    }
    if (e.target.closest('.lf-x')) {
      lineFilter = null
      renderLineFilter()
      renderRows()
      renderSvcPanel()
    }
  })

  const openToSearch = () => openSearch(applyToStop, 'to')
  openToSearchFn = openToSearch

  const { toStop } = getState()
  if (toStop) {
    applyToStop(toStop)
  } else {
    toRow.querySelector('#btn-set-to').addEventListener('click', openToSearch)
  }

  select.value = getState().destination
  select.addEventListener('change', () => {
    setDestination(select.value)
    renderRows()
  })
  opSelect.value = getState().operator
  opSelect.addEventListener('change', () => {
    setOperator(opSelect.value)
    renderRows()
  })

  function updateJFav() {
    const { toStop: t } = getState()
    const name = t ? savedJourneyName(origin, t) : ''
    jfav.disabled = !t
    jfav.textContent = !t
      ? '⭑ Name & save this journey (set a destination first)'
      : (name
          ? `★ “${name}” saved — click to remove`
          : '⭑ Name & save this journey')
    jfav.title = !t
      ? 'Pick a destination stop, then this journey can be saved' 
      : (name ? 'Remove the saved journey' : 'Give this trip a name (e.g. "To work") to save it')
  }
  function savedJourneyName(o, t) {
    return getFavJourneys().find((f) => journeyKey(f.origin, f.toStop) === journeyKey(o, t))?.name || ''
  }
  updateJFav()
  jfav.addEventListener('click', () => {
    const { toStop: t, destination, operator } = getState()
    if (!t) return
    if (isFavJourney(origin, t)) {
      removeFavJourney(origin, t)
      updateJFav()
      return
    }
    const hint = `${origin.label} → ${t.label}`
    const name = window.prompt('Name this journey (e.g. "To work on weekdays"):', hint)
    if (!name) return
    saveFavouriteJourney({ name, origin, toStop: t, destination, operator })
    updateJFav()
  })

  swap.addEventListener('click', () => {
    const { toStop: t } = getState()
    if (!t) return
    setOrigin(t)
    setToStop(origin)
    document.dispatchEvent(new Event('whichbus:reboot'))
  })
  document.removeEventListener('whichbus:tochange', updateJFav)
  document.addEventListener('whichbus:tochange', updateJFav)
  clear.addEventListener('click', () => {
    clearOrigin()
    document.dispatchEvent(new Event('whichbus:reboot'))
  })

  async function load({ background = false } = {}) {
    if (fetching) return
    fetching = true
    el.classList.add('loading')
    try {
      boardState = await (origin.kind === 'group' ? loadGroup(origin) : loadSingle(origin))
      lastLoadedAt = Date.now()
      stamp.textContent = `updated ${fmtTime()}`
      buildFilterOptions(select, opSelect)
      renderRows()
      refreshSvcPanel()
      refreshFareOps()
      void background
    } catch (err) {
      boardState = null
      el.dataset.error = String(err?.stack || err?.message || err)
      list.innerHTML = `<li class="empty error">Couldn’t load departures${navigator.onLine === false ? ' — offline' : ''}.<br><button id="retry" type="button">Retry</button></li>`
      list.querySelector('#retry')?.addEventListener('click', () => load())
    } finally {
      fetching = false
      el.classList.remove('loading')
    }
  }

  refresh.addEventListener('click', () => load())
  load()

  share.addEventListener('click', async () => {
    const url = buildShareUrl()
    try {
      await navigator.clipboard.writeText(url)
      stamp.textContent = 'link copied'
    } catch {
      window.prompt('Copy this link to share this journey:', url)
    }
    setTimeout(() => {
      stamp.textContent = `updated ${fmtTime()}`
    }, 1800)
  })

  clearInterval(timer)
  timer = setInterval(() => {
    if (Date.now() - lastLoadedAt > STALE_MS) load({ background: true })
  }, REFRESH_MS)
  document.removeEventListener('visibilitychange', onVisibleFn)
  onVisibleFn = () => {
    if (!document.hidden && Date.now() - lastLoadedAt > STALE_MS) load({ background: true })
  }
  document.addEventListener('visibilitychange', onVisibleFn)

  return el
}

async function loadSingle(o) {
  const r = await stopDepartures(o.atco)
  return {
    hasLive: !!r.hasLive,
    departures: (r.departures || []).map((d) => ({ ...d, bay: d.bay || bayFromLabel(o.label) })),
  }
}

async function loadGroup(o) {
  const results = await Promise.all(
    o.stops.map(async (s) => {
      try {
        return { stop: s, dep: await stopDepartures(s.atco) }
      } catch (e) {
        throw new Error(`stop ${JSON.stringify(s)}: ${e.message}`)
      }
    })
  )
  const seen = new Set()
  const departures = []
  let hasLive = false
  let stopsWith = 0
  for (const { stop, dep } of results) {
    if (!Array.isArray(dep.departures) || !dep.departures.length) continue
    stopsWith += 1
    hasLive = hasLive || !!dep.hasLive
    for (const d of dep.departures) {
      const dd = { ...d, bay: d.bay || bayFromLabel(stop.label), stopLabel: stop.label }
      const key = [dd.line, dd.destination, dd.scheduled, dd.expected].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      departures.push(dd)
    }
  }
  departures.sort((a, b) => cmpTime(a.scheduled || a.expected, b.scheduled || b.expected))
  return { hasLive, departures, stopsWith }
}

function cmpTime(a, b) {
  const ta = toTuple(a)
  const tb = toTuple(b)
  if (ta[0] !== tb[0]) return ta[0] - tb[0]
  return ta[1] - tb[1]
}

function toTuple(t) {
  const [h, m] = String(t ?? '').split(':').map(Number)
  return Number.isFinite(h) ? [h, m || 0] : [99, 99]
}

// A destination may be a merged group ("Cottingham King Street" ↑/↓), so ask
// every member stop and pool the answers. If every fetch fails we drop toInfo so
// the board stops filtering — "no evidence" must never hide a real departure.
async function loadToServices() {
  if (!toInfo) return null
  if (!toAtcos.length) return toInfo
  const per = await Promise.all(
    toAtcos.map((a) => stopServices(a).then((r) => r?.services || []).catch(() => null))
  )
  if (per.every((s) => s === null)) {
    toInfo = null
    return null
  }
  const services = per.flatMap((s) => s || [])
  toInfo = {
    ...toInfo,
    slugs: new Set(services.map((s) => s.slug).filter(Boolean)),
    lines: new Set(services.map((s) => s.line).filter(Boolean)),
    services,
  }
  return toInfo
}

async function loadToArrivals() {
  if (!toAtcos.length) {
    toArrivals = null
    toDir = null
    return null
  }
  const per = await Promise.all(
    toAtcos.map((a) => stopDepartures(a).then((r) => r?.departures || []).catch(() => null))
  )
  if (per.every((d) => d === null)) {
    toArrivals = null
    toDir = null
    return null
  }
  // Union of every member's termini per line: pooling directions makes the
  // verdict more permissive, which is the safe way to err for a merged board.
  const all = per.flatMap((d) => d || [])
  toDir = stopDirProfile(all)
  const m = new Map()
  for (const d of all) if (d.tripUrl && !m.has(d.tripUrl)) m.set(d.tripUrl, d)
  toArrivals = m
  return toArrivals
}

function svcOps(svc) {
  if (!svc || !svc.operators) return []
  return (Array.isArray(svc.operators) ? svc.operators : [svc.operators]).filter(Boolean)
}

// Stop services are cached upstream for a week, so one Map here keeps the fare
// note, the "services here" panel and the route filter off each other's toes.
async function cachedStopServices(atco) {
  if (!atco) return []
  if (stopServicesCache.has(atco)) return stopServicesCache.get(atco)
  const services = await stopServices(atco)
    .then((r) => r?.services || [])
    .catch(() => [])
  stopServicesCache.set(atco, services)
  return services
}

// Every service that calls at the departure point — including ones with no bus
// in the current window, which is exactly the question the panel answers.
async function ensureOriginServices() {
  if (originServices.length) return originServices
  const per = []
  for (const atco of atcosOf(boardOrigin)) per.push(await cachedStopServices(atco))
  const merged = new Map()
  for (const svc of per.flat()) {
    if (!svc?.slug || merged.has(svc.slug)) continue
    merged.set(svc.slug, svc)
  }
  originServices = [...merged.values()]
  if (typeof renderStopPanel === 'function') renderStopPanel('origin-panel', boardOrigin)

  return originServices
}

function nextTimeFor(slug, line) {
  const hit = (boardState?.departures || []).find(
    (d) => (slug && serviceSlug(d) === slug) || (!slug && d.line === line)
  )
  return hit ? hit.expected || hit.scheduled || null : null
}

function lineSort(a, b) {
  return String(a.line).localeCompare(String(b.line), 'en-GB', { numeric: true })
}

function renderSvcPanel() {
  const toggle = document.getElementById('svc-toggle')
  const list = document.getElementById('svc-list')
  if (!toggle || !list) return
  if (!originServices.length) {
    // A merged board only learns its service list once asked, so the toggle
    // leads with the promise and the count arrives with the answer.
    toggle.hidden = atcosOf(boardOrigin).length === 0
    toggle.textContent = 'Every service calling here — see the full list ▾'
    toggle.setAttribute('aria-expanded', String(svcOpen))
    list.hidden = !svcOpen
    if (svcOpen && !list.childElementCount) {
      list.innerHTML = `<p class="svc-loading">Checking which services call here…</p>`
    }
    return
  }
  const n = originServices.length
  toggle.hidden = false
  list.hidden = !svcOpen
  toggle.setAttribute('aria-expanded', String(svcOpen))
  toggle.textContent = svcOpen
    ? `Hide the ${n} services calling here ▴`
    : `${n} ${n === 1 ? 'service calls' : 'services call'} here — see all ▾`
  list.innerHTML = originServices
    .slice()
    .sort(lineSort)
    .map((svc) => {
      const next = nextTimeFor(svc.slug, svc.line)
      const active = lineFilter?.slug === svc.slug
      return `<button class="svc-chip${active ? ' on' : ''}${next ? '' : ' quiet'}" type="button"
        data-svc="${escapeHtml(svc.slug)}" data-line="${escapeHtml(svc.line || '')}"
        aria-pressed="${active}"
        title="${escapeHtml(next ? `Next ${next} — show only this service` : 'No departures in the next 24 hours — show only this service')}">
        <b>${escapeHtml(svc.line || '?')}</b>
        <span>${escapeHtml(svc.headline || '')}</span>
        <small>${next ? escapeHtml(next) : '–'}</small>
      </button>`
    })
    .join('')
}

function setLineFilter(slug) {
  const svc = serviceBySlug(slug)
  lineFilter = lineFilter?.slug === slug ? null : { slug, line: svc?.line || '' }
  renderLineFilter()
  renderRows()
  markSvcChips()
}

// Chips are long-lived so the next departure times and the pressed state are
// patched in place — re-rendering on every poll would drop keyboard focus.
function refreshSvcPanel() {
  const list = document.getElementById('svc-list')
  if (list && !list.hidden && list.querySelector('.svc-chip')) markSvcChips()
  else renderSvcPanel()
}

function markSvcChips() {
  for (const chip of document.querySelectorAll('#svc-list [data-svc]')) {
    const active = lineFilter?.slug === chip.dataset.svc
    const next = nextTimeFor(chip.dataset.svc, chip.dataset.line)
    chip.classList.toggle('on', active)
    chip.classList.toggle('quiet', !next)
    chip.setAttribute('aria-pressed', String(active))
    const small = chip.querySelector('small')
    if (small) small.textContent = next || '–'
  }
}

function renderLineFilter() {
  const box = document.getElementById('line-filter')
  if (!box) return
  if (!lineFilter) {
    box.hidden = true
    box.replaceChildren()
    return
  }
  const svc = serviceBySlug(lineFilter.slug)
  box.hidden = false
  box.innerHTML = `
    <button class="lf-go" type="button" data-route="${escapeHtml(lineFilter.slug)}" data-line="${escapeHtml(lineFilter.line || '')}"
      title="Show the stops on this route">▤ Route ${escapeHtml(lineFilter.line || '')} stops</button>
    <span class="lf-name">${escapeHtml(svc?.headline || '')}</span>
    <button class="lf-x" type="button" aria-label="Clear route filter">✕</button>`
}

function refreshFareOps() {
  const ops = new Set()
  for (const svc of toInfo?.services || []) for (const op of svcOps(svc)) ops.add(op)
  const atcos = atcosOf(boardOrigin)
  if (boardOrigin && atcos.length === 1) {
    cachedStopServices(atcos[0]).then((services) => {
      for (const op of services.flatMap(svcOps)) ops.add(op)
      fareOps = ops
      originServices = services
      renderFareNote()
      renderLineFilter()
      refreshSvcPanel()
    })
  } else {
    fareOps = ops
    renderFareNote()
  }
}

function renderFareNote() {
  const note = document.querySelector('#fare-note')
  if (!note) return
  const ops = [...fareOps].sort((a, b) => a.localeCompare(b))
  if (!ops.length) {
    note.hidden = true
    note.textContent = ''
    return
  }
  note.hidden = false
  note.textContent = `🎫 ${ops.join(' · ')} — contactless & cash taken on most buses · English concessionary passes valid after 09:30 · check the operator for ticket prices`
}

// Single entry point for choosing / clearing the destination. A merged group
// contributes every member atco, so a "Cottingham King Street" destination
// filters on all three of its stops rather than silently matching nothing.
function applyToStop(stop) {
  setToStop(stop)
  toAtcos = stop
    ? (stop.kind === 'group'
        ? (stop.stops || []).map((s) => s.atco).filter(Boolean)
        : [stop.atco].filter(Boolean))
    : []
  toInfo = stop
    ? { atco: stop.atco || null, slugs: null, lines: (stop.lines || []).length ? new Set(stop.lines) : null, services: [] }
    : null
  toArrivals = null
  toDir = null
  renderToChip(stop)
  renderRows()
  document.dispatchEvent(new Event('whichbus:tochange'))
  boardTo = stop
  if (typeof renderStopPanel === 'function') renderStopPanel('dest-panel', boardTo)
  const setDestBtn = document.querySelector('#btn-set-to')
  if (setDestBtn) setDestBtn.style.display = boardTo ? 'none' : 'inline-flex'

  if (!stop) return
  loadToServices().then(() => { renderRows(); refreshFareOps() })
  loadToArrivals().then(renderRows)
}

function renderToChip(stop) {
  const row = document.getElementById('to-row')
  if (!row) return
  if (!stop) {
    row.innerHTML = `<button class="to-add" id="btn-set-to" type="button">＋ Set destination…</button>`
    row.querySelector('#btn-set-to').addEventListener('click', () => openToSearchFn?.())
    return
  }
  const chip = document.createElement('div')
  chip.className = 'to-chip'
  chip.dataset.atco = stop.atco || ''
  const via = stop.kind === 'group' ? `${stop.stops.length} stops` : ''
  chip.innerHTML = `<span class="t-label">To: ${escapeHtml(stop.label)}${via ? ` <small>(${escapeHtml(via)})</small>` : ''}</span>
    <button class="to-x" type="button" aria-label="Clear destination">✕</button>`
  chip.querySelector('.to-x').addEventListener('click', () => applyToStop(null))
  row.replaceChildren(chip)
}

function serviceSlug(item) {
  if (item.serviceUrl?.startsWith('/services/')) return item.serviceUrl.slice('/services/'.length)
  return null
}

function operatorsFor(item, slug) {
  if (!toInfo?.services) return []
  const svc = toInfo.services.find((s) => s.line === item.line) || (slug ? toInfo.services.find((s) => s.slug === slug) : null)
  if (!svc || !svc.operators) return []
  return Array.isArray(svc.operators) ? svc.operators : [svc.operators]
}

function servesTo(item) {
  if (!toInfo) return true
  const slug = serviceSlug(item)
  const lineOk = slug
    ? toInfo.slugs?.has(slug) || toInfo.lines.has(item.line)
    : toInfo.lines.has(item.line)
  if (!lineOk) return false
  if (!toDir) return true
  return legVerdict(item, toDir) !== DIR.WRONG
}

function applyFilters(all) {
  let rows = toInfo ? all.filter(servesTo) : all
  const { operator, destination } = getState()
  if (lineFilter) {
    rows = rows.filter((r) => {
      const slug = serviceSlug(r)
      return slug ? slug === lineFilter.slug : r.line === lineFilter.line
    })
  }
  if (operator) rows = rows.filter((r) => operatorsFor(r, serviceSlug(r)).includes(operator))
  if (destination) rows = rows.filter((r) => r.destination === destination)
  return rows
}

function buildFilterOptions(select, opSelect) {
  const matching = toInfo ? (boardState?.departures || []).filter(servesTo) : boardState?.departures || []
  const d = new Set()
  const ops = new Set()
  for (const item of matching) {
    if (item.destination) d.add(item.destination)
    for (const op of operatorsFor(item, serviceSlug(item))) if (op) ops.add(op)
  }
  const dests = [...d].sort((a, b) => a.localeCompare(b))
  const opList = [...ops].sort((a, b) => a.localeCompare(b))
  const chosen = select.value
  const chosenOp = opSelect.value

  select.replaceChildren()
  if (!dests.length) select.disabled = true
  else {
    const all = document.createElement('option')
    all.value = ''
    all.textContent = 'All destinations'
    select.appendChild(all)
    for (const name of dests) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      select.appendChild(opt)
    }
    select.disabled = false
    if (chosen && dests.includes(chosen)) select.value = chosen
    else if (chosen) {
      setDestination('')
      select.value = ''
    }
  }

  opSelect.replaceChildren()
  if (!opList.length) {
    opSelect.disabled = true
    if (chosenOp) setOperator('')
    return
  }
  const allOp = document.createElement('option')
  allOp.value = ''
  allOp.textContent = 'Any operator'
  opSelect.appendChild(allOp)
  for (const name of opList) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    opSelect.appendChild(opt)
  }
  opSelect.disabled = false
  if (chosenOp && opList.includes(chosenOp)) opSelect.value = chosenOp
}

function depFrom(r) {
  if (boardOrigin?.kind === 'group') return r.stopLabel
  return r.bay
}

function renderRows() {
  const list = document.getElementById('dep-list')
  const foot = document.getElementById('board-foot')
  const select = document.getElementById('dest-select')
  if (!select) {
    // board not mounted (origin cleared) — guard module-level statelessness
    return
  }
  const hasLive = boardState?.hasLive
  const sel = document.getElementById('dest-select')
  const opSel = document.getElementById('op-select')
  if (sel && opSel) buildFilterOptions(sel, opSel)

  const matching = applyFilters(boardState?.departures || [])
  const rows = matching.slice(0, MAX_DEPARTURES)
  select.disabled = toInfo && !matching.length

  if (!rows.length) {
    list.innerHTML = `<li class="empty">${nothingMsg()}${
      lineFilter
        ? `<br><button id="clear-route" type="button">Clear route ${escapeHtml(lineFilter.line || '')} filter</button>`
        : ''
    }</li>`
    list.querySelector('#clear-route')?.addEventListener('click', () => {
      lineFilter = null
      renderLineFilter()
      renderRows()
    })
    foot.textContent = ''
    return
  }

  const anyDep = rows.some((r) => depFrom(r))

  list.innerHTML = rows
    .map((r) => {
      const schedTime = r.scheduled || r.expected || '—'
      const sched = r.cancelled
        ? `<s>${escapeHtml(schedTime)}</s>`
        : escapeHtml(schedTime)
      const mins = r.scheduled || r.expected ? minFromNow(r.expected || r.scheduled) : null
      const expRow = r.expected && r.expected !== r.scheduled
        ? `<span class="t t-exp"><small>Expected</small><b class="${r.cancelled ? 'cancelled' : 'live'}">${escapeHtml(r.expected)}</b></span>`
        : hasLive && !r.expected
          ? `<span class="t t-exp"><small>Expected</small><b class="no-live">–</b></span>`
          : ''
      const destDep = r.tripUrl && toArrivals ? toArrivals.get(r.tripUrl) : null
      const arrTime = destDep ? destDep.expected || destDep.scheduled || null : null
      const arrRow = arrTime
        ? `<span class="t t-arr"><small>Arrive</small><b class="arr${destDep.expected && destDep.expected !== destDep.scheduled ? ' live' : ''}${r.cancelled || destDep.cancelled ? ' cancelled' : ''}">${escapeHtml(arrTime)}</b></span>`
        : ''
      const inRow = mins !== null
        ? `<span class="t t-in"><small>in</small><b>${mins === 0 ? 'now' : `${mins} min`}</b></span>`
        : ''
      const from = anyDep ? depFrom(r) : null
      const slug = serviceSlug(r)
      return `
      <li class="row${r.cancelled ? ' cancelled' : ''}" data-service="${escapeHtml(slug || r.line || '')}">
        <span class="lbl">
          <span class="line">
            ${slug
              ? `<button class="line-btn" type="button" data-route="${escapeHtml(slug)}" data-line="${escapeHtml(r.line || '')}"
                   aria-label="Stops on route ${escapeHtml(r.line || '')}">${escapeHtml(r.line)}</button>`
              : escapeHtml(r.line || '—')}
          </span>
          <span class="dest">${escapeHtml(r.destination || '—')}</span>
          ${from ? `<span class="depfrom">🚏 ${escapeHtml(from)}</span>` : ''}
        </span>
        <span class="time">
          <span class="t t-sched"><small>Scheduled</small><b>${sched}</b></span>
          ${expRow}
          ${arrRow}
          ${inRow}
        </span>
      </li>`
    })
    .join('')

  const omitted = matching.length - rows.length
  const routeNote = lineFilter ? ` on route ${lineFilter.line || ''}` : ''
  markSvcChips()
  foot.textContent = omitted > 0
    ? `Showing next ${rows.length} of ${matching.length} departures${toInfo ? ' for buses to your destination' : ''}${routeNote}`
    : `Next ${rows.length} departures${toInfo ? ' — buses that go to your destination' : ''}${routeNote}`
}

function nothingMsg() {
  const { toStop, destination, operator, origin } = getState()
  if (toInfo) {
    const all = (boardState?.departures || []).length
    const destLabel = escapeHtml(toStop?.label || 'your destination')
    const here = [...new Set((boardState?.departures || []).map((d) => d.line))].sort((a, b) => String(a).localeCompare(b))
    if (toDir && !destination && !operator) {
      const wrongWay = (boardState?.departures || []).filter((d) => legVerdict(d, toDir) === DIR.WRONG)
      if (wrongWay.length) {
        const plural = wrongWay.length === 1 ? '' : 's'
        return [
          `No bus from <b>${escapeHtml(origin.label)}</b> heads to <b>${destLabel}</b> right now —`,
          `the ${escapeHtml(here.join(', ') || 'service')} calling here goes the other way at the moment.`,
          `Pick another stop close by, or remove the destination to see all departures.`,
        ].join(' ')
      }
    }
    if (all) {
      const plural = here.length === 1 ? '' : 's'
      return [
        `No buses from <b>${escapeHtml(origin.label)}</b> go to <b>${destLabel}</b>.`,
        `The service${plural} calling here (${escapeHtml(here.join(', '))}) don’t call at that stop.`,
        `Remove the destination to see all ${escapeHtml(origin.label)} departures.`,
      ].join(' ')
    }
    return `No departures right now from <b>${escapeHtml(origin.label)}</b> to <b>${destLabel}</b>.`
  }
  const scope = boardState?.stopsWith ? `No departures across its ${boardState.stopsWith} stops` : 'No departures'
  return `${scope}${destination ? ` to ${escapeHtml(destination)}` : ''} right now.`
}

function minFromNow(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const now = new Date()
  const target = new Date(now)
  target.setHours(h, m, 0, 0)
  let mins = Math.round((target - now) / 60000)
  if (mins < -720) mins += 1440
  if (mins < -2) return null
  if (mins < 0) mins = 0
  return mins
}

function fmtTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function bayFromLabel(label) {
  const m = String(label ?? '').match(/\(?(?:bay|stance|stand|gate|stop|platform)\s*[A-Za-z0-9]*\)?/i)
  return m ? m[0].replace(/[()]/g, '') : null
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function routeNums(lines) {
  const set = new Set()
  for (const l of lines || []) {
    const v = (l || '').trim()
    if (v) set.add(v)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'en-GB', { numeric: true }))
}

function routeNumStr(lines) {
  return routeNums(lines).join(' ')
}

function renderStopPanel(containerId, stopInfo) {
  const container = document.getElementById(containerId)
  if (!container || !stopInfo) return
  const isGroup = stopInfo.kind === 'group' || Array.isArray(stopInfo.stops)
  const label = stopInfo.label || ''
  const count = isGroup ? (stopInfo.stops?.length || 0) : 0
  const fav = isFavourite(stopInfo)
  const members = isGroup ? (stopInfo.stops || []) : [stopInfo]

  let lines = []
  if (isGroup) {
    lines = members.flatMap((m) => m.lines || [])
  } else if (containerId === 'origin-panel') {
    lines = (originServices || []).map((svc) => svc.line)
    if (!lines.length && stopInfo.atco) {
      cachedStopServices(stopInfo.atco).then((svcs) => {
        if (svcs.length) {
          originServices = svcs
          renderStopPanel(containerId, stopInfo)
        }
      }).catch(() => {})
    }
  } else {
    lines = stopInfo.lines || (stopInfo.services || []).map((svc) => svc.line)
    if (!lines.length && stopInfo.atco) {
      cachedStopServices(stopInfo.atco).then((svcs) => {
        if (svcs.length) {
          stopInfo.lines = svcs.map((svc) => svc.line)
          stopInfo.services = svcs
          renderStopPanel(containerId, stopInfo)
        }
      }).catch(() => {})
    }
  }

  let html = '<div class="stop-panel large">'
  html += '<div class="stop-panel-head">'
  html += '<button class="fav-toggle large" data-fav-panel="' + escapeHtml(containerId) + '" type="button" title="Favourite">' + (fav ? '★' : '☆') + '</button>'
  html += '<div class="stop-panel-title">'
  html += '<span class="stop-panel-icon">' + (isGroup ? '🏛' : '🚏') + '</span>'
  html += '<span class="stop-panel-name">' + escapeHtml(label) + '</span>'
  html += '<button class="icon-btn small" data-replace="' + escapeHtml(containerId) + '" type="button" title="Replace stop">🔍</button>'
  html += '</div></div>'
  html += '<div class="stop-panel-body">'

  if (isGroup) {
    html += '<details class="group-members"><summary>' + count + ' stops</summary>'
    html += '<div class="member-list">'
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      const mf = isFavourite(m)
      const nums = routeNumStr(m.lines)
      html += '<div class="member-row">'
      html += '<button class="fav-toggle small" data-fav-mem="' + i + '" type="button">' + (mf ? '★' : '☆') + '</button>'
      html += '<span class="member-name">' + escapeHtml(m.label) + '</span>'
      html += '<span class="member-routes">' + escapeHtml(nums) + '</span>'
      html += '</div>'
    }
    html += '</div></details>'
    const nums = routeNumStr(lines)
    if (nums) html += '<div class="route-nums">' + escapeHtml(nums) + '</div>'
  } else {
    const nums = routeNumStr(lines)
    html += '<div class="route-nums">' + (nums ? escapeHtml(nums) : '<span class="muted">…</span>') + '</div>'
  }

  html += '</div></div>'
  container.innerHTML = html
  container.querySelector('[data-fav-panel]')?.addEventListener('click', (e) => { e.stopPropagation(); toggleFavourite(stopInfo); renderStopPanel(containerId, stopInfo) })
  container.querySelectorAll('[data-fav-mem]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = parseInt(btn.dataset.favMem,10)
      const m = members[idx]
      if (m) { toggleFavourite(m); renderStopPanel(containerId, stopInfo) }
    })
  })
  container.querySelector('[data-replace]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (containerId === 'origin-panel') {
      if (replaceOriginFn) replaceOriginFn()
      else openSearch(() => {}, 'origin')
    } else if (containerId === 'dest-panel') {
      if (openToSearchFn) openToSearchFn()
      else openSearch((s) => { applyToStop(s) }, 'to')
    }
  })
}
