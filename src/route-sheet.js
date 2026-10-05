// Route detail: the stops a service calls at, in running order.
//
// One renderer, two presentations. Where the pointer can hover (desktop) the
// sheet appears beside the route number on hover/focus and dismisses itself;
// on touch there is no hover, so a tap opens it as a bottom sheet pinned until
// dismissed. Data is fetched on first open only — a service page is ~90KB of
// timetable, so it is never speculated ahead of a real gesture.

import { serviceStops } from './api.js'
import { UPSTREAM_URL } from './config.js'

const HOVER_DELAY_MS = 140
const HOVER_LEAVE_MS = 260

const cache = new Map() // slug -> { calendar, directions }
const inflight = new Map()

let sheet = null
let backdrop = null
let anchor = null
let pinned = false
let openTimer = null
let closeTimer = null
let lastFocus = null
let scrollLock = false

function hoverCapable() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches
}

function stopTimers() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  openTimer = closeTimer = null
}

function loadRoute(slug) {
  const hit = cache.get(slug)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(slug)
  if (pending) return pending
  const req = serviceStops(slug)
    .then((data) => {
      cache.set(slug, data)
      return data
    })
    .finally(() => inflight.delete(slug))
  inflight.set(slug, req)
  return req
}

function mount() {
  if (sheet) return sheet
  backdrop = document.createElement('div')
  backdrop.className = 'rs-backdrop'
  backdrop.addEventListener('click', () => close())

  sheet = document.createElement('div')
  sheet.className = 'rs-sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'false')
  sheet.hidden = true
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSheet()
    }
  })
  // The card is interactive in hover mode too: keep it open while the pointer
  // crosses from the route number into the list.
  sheet.addEventListener('pointerenter', stopTimers)
  sheet.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') leaveRoute()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet && !sheet.hidden) closeSheet()
  })
  document.addEventListener('pointerdown', (e) => {
    if (!sheet || sheet.hidden || pinned) return
    if (sheet.contains(e.target)) return
    if (anchor?.contains(e.target)) return
    closeSheet({ restoreFocus: false })
  })

  document.body.append(backdrop, sheet)
  return sheet
}

// Which direction to show first: the one that runs through both ends of the
// journey, else the one that calls at where you are standing.
function pickDirection(directions, fromAtcos, toAtcos) {
  const calls = (dir, atcos) => atcos.some((a) => dir.stops.some((s) => s.atco === a))
  return (
    directions.find((d) => calls(d, fromAtcos) && toAtcos.length && calls(d, toAtcos)) ||
    directions.find((d) => calls(d, fromAtcos)) ||
    directions[0]
  )
}

function atcoIndex(dir, atcos) {
  const at = new Set(atcos)
  return dir.stops.findIndex((s) => at.has(s.atco))
}

function renderStops(dir, { fromAtcos, toAtcos }) {
  const from = atcoIndex(dir, fromAtcos)
  const to = atcoIndex(dir, toAtcos)
  const list = document.createElement('ol')
  list.className = 'rs-stops'
  for (const [i, stop] of dir.stops.entries()) {
    const li = document.createElement('li')
    const isFrom = i === from
    const isTo = i === to
    if (isFrom) li.classList.add('here')
    if (isTo) li.classList.add('dest')

    const num = document.createElement('span')
    num.className = 'rs-num'
    num.textContent = String(i + 1)

    const details = document.createElement('details')
    if (isFrom || isTo) details.open = true
    const summary = document.createElement('summary')
    summary.textContent = stop.name
    details.append(summary)
    if (stop.times?.length) {
      const times = document.createElement('p')
      times.className = 'rs-times'
      times.textContent = stop.times.filter(Boolean).join(' · ')
      details.append(times)
    }
    if (isFrom) {
      const tag = document.createElement('span')
      tag.className = 'rs-tag'
      tag.textContent = 'you are here'
      summary.append(tag)
    } else if (isTo) {
      const tag = document.createElement('span')
      tag.className = 'rs-tag'
      tag.textContent = 'your destination'
      summary.append(tag)
    }
    li.append(num, details)
    list.append(li)
  }
  return list
}

function render(slug, opts, data) {
  const { line, headline, fromAtcos = [], toAtcos = [], serviceUrl } = opts
  const dirs = data.directions || []
  sheet.replaceChildren()

  const head = document.createElement('header')
  head.className = 'rs-head'
  const badge = document.createElement('span')
  badge.className = 'rs-line'
  badge.textContent = line || 'Route'
  const titles = document.createElement('div')
  titles.className = 'rs-titles'
  const title = document.createElement('b')
  title.textContent = headline || dirs[0]?.name || slug
  titles.append(title)
  const sub = document.createElement('small')
  sub.textContent = [
    data.calendar,
    `${dirs.reduce((n, d) => n + d.stops.length, 0)} stops`,
  ]
    .filter(Boolean)
    .join(' · ')
  titles.append(sub)
  const up = document.createElement('a')
  up.className = 'rs-up'
  up.href = `${UPSTREAM_URL}/services/${encodeURIComponent(slug)}`
  up.target = '_blank'
  up.rel = 'noopener'
  up.textContent = 'timetable ↗'
  const close = document.createElement('button')
  close.className = 'rs-x'
  close.type = 'button'
  close.setAttribute('aria-label', 'Close route stops')
  close.textContent = '✕'
  close.addEventListener('click', () => closeSheet())
  head.append(badge, titles, up, close)

  sheet.append(head)

  if (!dirs.length) {
    const empty = document.createElement('p')
    empty.className = 'rs-empty'
    empty.textContent = 'No stop list published for this service.'
    sheet.append(empty)
    return
  }

  let dir = pickDirection(dirs, fromAtcos, toAtcos)
  const holder = document.createElement('div')
  holder.className = 'rs-body'

  // Tabs are a sibling of the list, not a child: painting a direction replaces
  // only the stops, so the direction switcher survives.
  if (dirs.length > 1) {
    const tabs = document.createElement('div')
    tabs.className = 'rs-dirs'
    tabs.setAttribute('role', 'tablist')
    for (const d of dirs) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.className = 'rs-dir'
      if (d === dir) tab.setAttribute('aria-selected', 'true')
      tab.textContent = d.name || 'Direction'
      tab.addEventListener('click', () => {
        dir = d
        for (const other of tabs.children) other.setAttribute('aria-selected', String(other === tab))
        paint()
      })
      tabs.append(tab)
    }
    sheet.append(tabs)
  }

  function paint() {
    holder.replaceChildren(renderStops(dir, { fromAtcos, toAtcos }))
    const i = atcoIndex(dir, fromAtcos)
    if (i >= 0) {
      holder.querySelectorAll('.rs-stops > li')[i]?.scrollIntoView?.({ block: 'center' })
    }
  }

  paint()
  sheet.append(holder)

  const foot = document.createElement('p')
  foot.className = 'rs-foot'
  foot.textContent = 'Stops in running order, from bustimes.org. Tap a stop for its times.'
  sheet.append(foot)
}

function place() {
  if (!sheet || !anchor || !hoverCapable()) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  sheet.style.left = ''
  sheet.style.top = ''
  const box = sheet.getBoundingClientRect()
  const w = box.width || Math.min(460, vw - 16)
  const h = box.height || 240
  const r = anchor.getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left, vw - w - 8))
  const above = r.top - h - 10
  const top = above > 8 ? above : Math.min(r.bottom + 10, vh - h - 8)
  sheet.style.left = `${left}px`
  sheet.style.top = `${Math.max(8, top)}px`
}

function lockScroll(on) {
  if (on === scrollLock) return
  scrollLock = on
  document.body.style.overflow = on ? 'hidden' : ''
}

async function open(opts, { trigger = 'tap', keepPinned = false } = {}) {
  const { slug, line, headline, fromAtcos, toAtcos, serviceUrl } = opts
  if (!slug) return
  stopTimers()
  anchor = opts.anchor || anchor
  const el = mount()
  el.dataset.slug = slug
  pinned = keepPinned || trigger === 'tap' || !hoverCapable()
  el.dataset.mode = pinned ? 'pin' : 'hover'
  el.setAttribute('aria-modal', pinned ? 'true' : 'false')
  el.setAttribute('aria-label', `Stops on route ${line || slug}`)
  backdrop.hidden = !pinned
  el.hidden = false
  if (pinned) {
    lastFocus = document.activeElement
    lockScroll(true)
  }

  el.replaceChildren()
  const loading = document.createElement('p')
  loading.className = 'rs-empty'
  loading.textContent = cache.has(slug) ? 'Loading stops…' : 'Loading the stop list…'
  el.append(loading)
  place()

  try {
    const data = await loadRoute(slug)
    if (!el.isConnected || el.dataset.slug !== slug) return
    render(slug, { line, headline, fromAtcos, toAtcos, serviceUrl }, data)
    place()
    if (pinned) el.querySelector('.rs-x')?.focus()
  } catch (err) {
    if (!el.isConnected || el.dataset.slug !== slug) return
    el.replaceChildren()
    const msg = document.createElement('p')
    msg.className = 'rs-empty err'
    msg.textContent = 'Couldn’t load the stop list — check your connection.'
    const retry = document.createElement('button')
    retry.className = 'rs-retry'
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.addEventListener('click', () => open({ ...opts, anchor }, { keepPinned: pinned }))
    el.append(msg, retry)
    place()
    void err
  }
}

function closeSheet({ restoreFocus = true } = {}) {
  stopTimers()
  if (!sheet) return
  sheet.hidden = true
  backdrop.hidden = true
  sheet.dataset.slug = ''
  lockScroll(false)
  const wasPinned = pinned
  pinned = false
  if (wasPinned && restoreFocus && lastFocus?.isConnected) lastFocus.focus()
  lastFocus = null
}

function close() {
  closeSheet()
}

export function hoverRoute(btn, opts) {
  if (!hoverCapable()) return
  if (sheet && !sheet.hidden && sheet.dataset.slug === opts.slug) return
  stopTimers()
  openTimer = setTimeout(() => open({ ...opts, anchor: btn }, { trigger: 'hover' }), HOVER_DELAY_MS)
}

export function leaveRoute() {
  if (!sheet || !hoverCapable()) return
  stopTimers()
  closeTimer = setTimeout(() => {
    if (!pinned && !sheet?.contains(document.activeElement)) closeSheet({ restoreFocus: false })
  }, HOVER_LEAVE_MS)
}

export function tapRoute(btn, opts) {
  if (sheet && !sheet.hidden && sheet.dataset.slug === opts.slug) {
    closeSheet()
    return
  }
  open({ ...opts, anchor: btn }, { trigger: 'tap' })
}

// Keyboard focus lands on the route button; treat it like hover so tabbing
// through the board reveals each route without a pointer.
export function focusRoute(btn, opts) {
  stopTimers()
  open({ ...opts, anchor: btn }, { trigger: 'focus' })
}

export function blurRoute() {
  if (pinned) return
  stopTimers()
  closeTimer = setTimeout(() => {
    if (!sheet?.contains(document.activeElement)) closeSheet({ restoreFocus: false })
  }, HOVER_LEAVE_MS)
}