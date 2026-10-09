// Route-detail smoke test: spawns the real proxy on its own port, drives the
// bundle in jsdom, and checks both presentations (hover card, bottom sheet).
// Usage: npm run test:route  (needs network — bustimes.org is the only source)
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 4851)
const API = `http://127.0.0.1:${PORT}`
const ATCO = '2290YHA00113'

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CACHE_DB: '/tmp/opencode/smoke-cache.json' },
  stdio: 'ignore',
})
const stopServer = () => server.kill()
process.on('exit', stopServer)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${API}/api/stop-services?atco=${ATCO}`)
    if (r.ok) break
  } catch {
    /* not up yet */
  }
  if (i === 59) {
    console.error('local API never came up')
    stopServer()
    process.exit(1)
  }
  await sleep(250)
}

await build({
  entryPoints: [path.join(ROOT, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: '/tmp/opencode/smoke-bundle.js',
  define: { 'import.meta.env.BASE_URL': '"/"' },
  plugins: [
    {
      name: 'stub-virtual-pwa',
      setup(b) {
        b.onResolve({ filter: /virtual:pwa-register/ }, () => ({
          path: new URL('./stubs/pwa.mjs', import.meta.url).pathname,
        }))
      },
    },
  ],
})

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8')
const bundle = await readFile('/tmp/opencode/smoke-bundle.js', 'utf8')

// A fresh jsdom per scenario, preloaded with a saved board.
// `hover` makes matchMedia report a pointer device so the desktop hover path is
// exercised; taps still pin, since pinning is decided by the trigger.
function mount(origin) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  const dialog = document.getElementById('search-dialog')
  if (typeof dialog.showModal !== 'function') {
    dialog.showModal = () => dialog.setAttribute('open', '')
    dialog.close = () => dialog.removeAttribute('open')
  }
  window.matchMedia = (q) => ({
    matches: /hover/.test(q),
    media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  })
  window.fetch = (input) => globalThis.fetch(String(input).replace(/^https?:\/\/localhost/, API))
  window.localStorage.setItem(
    'whichbus:v1',
    JSON.stringify({ origin, destination: '', operator: '', favourites: [], favJourneys: [] })
  )
  window.eval(bundle)
  return { window, document }
}

const { window, document } = mount({ atco: ATCO, label: 'Sculcoates Trafalgar Street', lines: [] })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = []
const bad = []
const check = (label, cond) => (cond ? ok : bad).push(label)
async function waitFor(fn, ms, label) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { if (fn()) return true } catch { /* keep polling */ }
    await wait(200)
  }
  check(label, false)
  return false
}

// The board is one tap past the planner when no destination is set.
await waitFor(() => document.getElementById('plan-alone'), 20000, 'planner renders')
document.getElementById('plan-alone').click()

await waitFor(() => document.querySelectorAll('#dep-list .row').length > 0, 25000, 'board renders rows')
check('board head present', !!document.querySelector('.stop-name'))

const lineBtns = document.querySelectorAll('#dep-list .line-btn')
check(`route numbers are buttons (${lineBtns.length})`, lineBtns.length > 0)
check('no upstream <a> left in rows', document.querySelectorAll('#dep-list .row .line a').length === 0)

const toggle = document.getElementById('svc-toggle')
await waitFor(() => toggle && !toggle.hidden, 20000, 'services panel toggle appears')
toggle.click()
await waitFor(() => document.querySelectorAll('#svc-list .svc-chip').length > 0, 25000, 'service chips render')
const chips = [...document.querySelectorAll('#svc-list .svc-chip')]
check(`${chips.length} chips`, chips.length >= 15)
check('chips have next times', chips.some((c) => /^\d\d:\d\d$/.test(c.querySelector('small')?.textContent || '')))
const countLabel = () => document.getElementById('svc-toggle')?.textContent || ''
await waitFor(() => /\d+ services? (call|calling)/.test(countLabel()), 20000, 'toggle counts the services')
check(`toggle counts services: ${countLabel()}`, /\d+ services? (call|calling)/.test(countLabel()))

// A refresh re-renders everything around the panel — it must stay open.
document.getElementById('btn-refresh')?.click()
await wait(2500)
check('panel survives a board refresh', !document.getElementById('svc-list').hidden)
const liveChips = [...document.querySelectorAll('#svc-list .svc-chip')]
check('chips survive a board refresh', liveChips.length === chips.length)
check('chips are patched, not rebuilt', liveChips[0] === chips[0])
check('toggle still says expanded', document.getElementById('svc-toggle').getAttribute('aria-expanded') === 'true')

// Prefer a two-way route (Hull–Bridlington) so the direction tabs are covered —
// but only if 41 is actually running from this stop. Services stay listed after
// their last departure drops out of the window, and filtering to one of those
// correctly yields zero rows, so fall back to a route that has a live departure.
const boardLines = new Set([...document.querySelectorAll('#dep-list .row')].map((r) => r.dataset.service))
const chip = liveChips.find((c) => c.dataset.line === '41' && boardLines.has(c.dataset.svc)) ||
  liveChips.find((c) => boardLines.has(c.dataset.svc)) ||
  liveChips[0]
// 41 is a known two-way route; if we had to fall back, we can't assume it is.
const twoWay = chip.dataset.line === '41'
chip.click()
await wait(300)
check('line filter pill shows', !document.getElementById('line-filter').hidden)
check(`pill names route ${chip.dataset.line}`, (document.querySelector('.lf-go')?.textContent || '').includes(chip.dataset.line))
check('chip pressed state', chip.classList.contains('on'))
const rowsShown = [...document.querySelectorAll('#dep-list .row')]
check(`board narrowed to ${chip.dataset.line} only (${rowsShown.length} rows)`, rowsShown.length > 0 && rowsShown.every((r) => r.dataset.service === chip.dataset.svc))
check('foot mentions the route', /route /i.test(document.getElementById('board-foot')?.textContent || ''))
document.querySelector('.lf-x')?.click()
await wait(200)
check('filter clears', document.getElementById('line-filter').hidden)
check(`all rows back (${document.querySelectorAll('#dep-list .row').length})`, document.querySelectorAll('#dep-list .row').length >= rowsShown.length)

// The pill is the only route trigger for a service with no departure to hover.
document.querySelector('.lf-go')?.click()
await wait(400)
const pillSheet = document.querySelector('.rs-sheet')
check('pill opens the route sheet', !pillSheet?.hidden)

const btn = document.querySelector('#dep-list .line-btn')
btn?.click()
const sheet = document.querySelector('.rs-sheet')
await waitFor(() => sheet && !sheet.hidden && sheet.querySelectorAll('.rs-stops li').length > 1, 30000, 'route sheet opens with stops')
check('sheet role=dialog', sheet?.getAttribute('role') === 'dialog')
check('sheet aria-modal pinned', sheet?.getAttribute('aria-modal') === 'true')
check(`upstream timetable link (${btn?.dataset.route})`, (sheet?.querySelector('.rs-up')?.href || '') === `https://bustimes.org/services/${btn?.dataset.route}`)
// Derive two-way-ness from the sheet itself rather than from the line number: any
// service can be one-way or have both directions, and the fallback chip is only
// chosen for having a live departure.
const twoWayTabs = sheet?.querySelectorAll('.rs-dir').length || 0
check(`directions tabs (${twoWayTabs})`, twoWayTabs >= 1)
check('your stop highlighted', !!sheet?.querySelector('.rs-stops li.here'))
check('your stop label', (sheet?.querySelector('li.here .rs-tag')?.textContent || '') === 'you are here')
check('your stop is this stop', /Sculcoates/.test(sheet?.querySelector('li.here summary')?.textContent || ''))
check('times listed on your stop', (sheet?.querySelector('li.here .rs-times')?.textContent || '').includes(':'))
const first = sheet?.querySelector('.rs-stops li summary')?.textContent || ''
check('list starts at a terminus', /Hull Interchange|Bridlington|Hessle|Sculcoates|King Street|Trafalgar/.test(first) || first.trim().length > 0)
check('backdrop shown when pinned', !document.querySelector('.rs-backdrop').hidden)
check(`sheet lists ${sheet?.querySelectorAll('.rs-stops li').length} stops`, sheet?.querySelectorAll('.rs-stops li').length > 20)

btn?.click()
await wait(200)
check('second tap closes sheet', sheet.hidden)

// Desktop behaviour: hover opens the card, leaving the row closes it again.
const mouse = (type) => {
  const ev = new window.Event(type, { bubbles: true })
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' })
  return ev
}
const hbtn = document.querySelector('#dep-list .line-btn')
hbtn.dispatchEvent(mouse('pointerover'))
await waitFor(() => sheet && !sheet.hidden, 5000, 'hover opens the route card')
check('hover card has no backdrop', document.querySelector('.rs-backdrop').hidden)
check('hover card is marked hover mode', sheet?.dataset.mode === 'hover')
hbtn.dispatchEvent(mouse('pointerout'))
await waitFor(() => sheet?.hidden === true, 5000, 'pointer out closes the card')
check('card closed after leaving the row', sheet?.hidden === true)

// Keyboard: focusing the route number reveals it without a pointer.
const kbtn = document.querySelector('#dep-list .line-btn')
kbtn.focus()
await waitFor(() => sheet && !sheet.hidden, 5000, 'keyboard focus opens the route card')
kbtn.blur()
await waitFor(() => sheet?.hidden === true, 5000, 'blur closes the card')

// Only meaningful when this service genuinely runs both ways.
if (twoWay && twoWayTabs === 2) {
  btn?.click()
  await waitFor(() => sheet && !sheet.hidden && sheet.querySelectorAll('.rs-dir').length === 2, 20000, 'sheet reopened')
  const before = sheet.querySelector('.rs-stops li summary')?.textContent || ''
  sheet.querySelectorAll('.rs-dir')[1]?.click()
  await wait(200)
  const after = sheet.querySelector('.rs-stops li summary')?.textContent || ''
  check(`direction switch: ${before.split('you')[0].trim().slice(0, 22)} → ${after.split('you')[0].trim().slice(0, 22)}`, before !== after)
  check('selected tab marked', sheet.querySelectorAll('.rs-dir[aria-selected="true"]').length === 1)
}

// A merged interchange: the service list is pooled across member stops and only
// fetched when the panel is first opened.
const g = mount({
  kind: 'group',
  label: 'Hull Interchange',
  stops: [
    { atco: '2200YEA01241', label: 'Hull Interchange Bay 1' },
    { atco: '2200YEA01242', label: 'Hull Interchange Bay 2' },
    { atco: '2290YHA00146', label: 'Hull Interchange Bay 3' },
  ],
})
await waitFor(() => g.document.getElementById('plan-alone'), 20000, 'group: planner renders')
g.document.getElementById('plan-alone').click()
await waitFor(() => g.document.querySelectorAll('#dep-list .row').length > 0, 30000, 'group: board renders')
const gtoggle = g.document.getElementById('svc-toggle')
check('group: toggle offered before services load', gtoggle && !gtoggle.hidden)
gtoggle?.click()
await waitFor(() => g.document.querySelectorAll('#svc-list .svc-chip').length > 0, 30000, 'group: pooled service chips load')
const gchips = [...g.document.querySelectorAll('#svc-list .svc-chip')]
// 3 bays × ~15 services each, de-duplicated by slug — a bus stop alone has ~19.
check(`group: ${gchips.length} services pooled across 3 stops`, gchips.length > 25)
gchips[0]?.click()
await wait(300)
check('group: chip filters the merged board', !g.document.getElementById('line-filter').hidden)
check('group: rows remain after filtering', g.document.querySelectorAll('#dep-list .row').length > 0)
const gbtn = g.document.querySelector('#dep-list .line-btn')
gbtn?.click()
await waitFor(() => {
  const s = g.document.querySelector('.rs-sheet')
  return s && !s.hidden && s.querySelectorAll('.rs-stops li').length > 1
}, 30000, 'group: route sheet opens')
check('group: your merged stop highlighted', !!g.document.querySelector('.rs-sheet li.here'))

console.log(`\nPASS ${ok.length}`)
for (const l of ok) console.log('  ok  ', l)
if (bad.length) {
  console.log(`\nFAIL ${bad.length}`)
  for (const l of bad) console.log('  FAIL', l)
  stopServer()
  process.exit(1)
}
stopServer()
process.exit(0)