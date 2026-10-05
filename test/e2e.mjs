import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'

// No hostname is baked in anywhere in this repo — the public URL is a deployment
// detail that lives in the stack's Traefik labels. Default to a local server; to
// test a deployed instance pass WB_ORIGIN explicitly:
//   npm run build && npm start   →   npm test
//   WB_ORIGIN=https://my-host WB_BASE=/whichbus npm test
const DEPLOYED = process.env.WB_ORIGIN || 'http://localhost:4848'
const BASE = process.env.WB_BASE === undefined ? '/whichbus' : process.env.WB_BASE

// 1. Bundle client as IIFE
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: '/tmp/opencode/e2e.js',
  define: { 'import.meta.env.BASE_URL': `"${BASE}/"` },
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

const html = await readFile('index.html', 'utf8')
const bundle = await readFile('/tmp/opencode/e2e.js', 'utf8')

const dom = new JSDOM(html, {
  url: DEPLOYED + BASE + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})
const { window } = dom
const { document } = window

// dialog polyfill (jsdom lacks showModal)
const dialog = document.getElementById('search-dialog')
if (typeof dialog.showModal !== 'function') {
  dialog.showModal = () => {
    dialog.setAttribute('open', '')
    dialog.dispatchEvent(new window.Event('open'))
  }
  dialog.close = () => {
    dialog.removeAttribute('open')
    dialog.dispatchEvent(new window.Event('close'))
  }
}

// fetch that routes to the real deployed API
window.fetch = async (input) => {
  const url = String(input)
  if (url.startsWith('/')) {
    const rel = url.startsWith(BASE) ? url : BASE + url
    const res = await fetch(DEPLOYED + rel, {
      headers: { Accept: 'application/json' },
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, json: async () => body }
  }
  return globalThis.fetch(input)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function resultsTexts() {
  return [...document.querySelectorAll('#search-results .result')].map((li) =>
    li.textContent.replace(/\s+/g, ' ').trim()
  )
}

// upstream is live and rate-limited: never race it with a fixed sleep
const waitForRows = (label, timeoutMs = 25000) =>
  waitFor(() => document.querySelectorAll('#search-results .result').length > 0, timeoutMs, label)

async function waitFor(fn, timeoutMs, label = 'cond') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await wait(300)
  }
  const state = {
    app: document.getElementById('app')?.innerHTML.slice(0, 200),
    boardError: document.querySelector('.board')?.dataset.error,
    rows: document.querySelectorAll('#dep-list .row').length,
    empty: document.querySelector('#dep-list .empty')?.textContent.trim().slice(0, 60),
    errors: window.__e2eErrors || [],
  }
  throw new Error(label + ' timed out after ' + timeoutMs + 'ms — ' + JSON.stringify(state).slice(0, 500))
}

function getViaAtcoFromChip(chip) {
  return chip ? chip.dataset.atco : null
}

function b64urlToBytes(b64) {
  const safe = b64.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(safe)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function main() {
  const errors = []
  window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message))
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)))
  window.__e2eErrors = errors
  window.navigator.clipboard = { writeText: async (t) => { window.__shared = t } }
  window.eval(bundle)
  await wait(100)
  // app boot: no origin saved -> hero
  const heroBtn = document.querySelector('.btn-primary')
  if (!heroBtn) throw new Error('hero not booted — app error on load')
  heroBtn.click()
  await wait(50)

  const input = document.getElementById('search-input')
  input.value = 'hull'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for hull')

  let texts = await resultsTexts()
  console.log('SEARCH RESULTS:', texts.length)
  console.log(texts.slice(0, 10).join(' | '))

  // click the locality result named "Hull"
  const hull = [...document.querySelectorAll('#search-results .result')].find(
    (li) => li.textContent.replace(/\s+/g, ' ').trim().split('›')[0].trim().toLowerCase() === 'hull' ||
      li.textContent.includes('Hull')
  )
  if (!hull) throw new Error('no "Hull" locality result' + (errors.length ? ' — client errors: ' + errors.join(' | ').slice(0, 400) : ''))
  hull.click()
  await waitForRows('stops in hull')

  texts = await resultsTexts()
  console.log('STOPS LISTED:', texts.length)
  if (texts.length) console.log('first:', texts[0].slice(0, 120))

  // click the stop row "14th Avenue" (list is grouped by direction, not sorted by name)
  const originRow = [...document.querySelectorAll('#search-results .result')].find((li) =>
    li.textContent.replace(/\s+/g, ' ').replace('＋', '').trim().startsWith('🚏14th Avenue')
  )
  if (!originRow) throw new Error('no 14th Avenue stop row in locality list')
  originRow.click()
  await wait(600)

  // after picking a departure point we should be prompted for a destination first
  const planTo = document.querySelector('.plan #plan-to')
  const planAlone = document.querySelector('.plan #plan-alone')
  if (!planTo || !planAlone) throw new Error('expected "choose destination" plan screen after picking origin')
  console.log('PLAN SCREEN: OK')
  planAlone.click() // still allow viewing the stop alone
  await wait(2500)

  const originPill = document.getElementById('origin-btn').textContent
  console.log('ORIGIN:', originPill)
  const rows = document.querySelectorAll('#dep-list .row').length
  const empty = document.querySelector('#dep-list .empty')
  console.log('BOARD ROWS:', rows, empty ? `EMPTY: ${empty.textContent.trim().slice(0, 40)}` : '')

  const metaChips = document.querySelectorAll('.board .stop-meta .chip').length
  console.log('META CHIPS:', metaChips)
  if (metaChips) throw new Error('bus-number chips still listed at journey start')

  const firstLbl = document.querySelector('.row .lbl')
  const lineText = firstLbl?.querySelector('.line')?.textContent.trim()
  const destBeside = firstLbl?.textContent.includes('Hull')
  console.log('LBL:', lineText, '| destination beside line:', !!destBeside)
  if (!destBeside) {
    console.log('BOARD SNAP:', rows, 'rows | first:', firstLbl?.textContent.replace(/\s+/g, ' ').trim().slice(0, 100), '| empty:', empty?.textContent.trim().slice(0, 60))
    throw new Error('destination not rendered beside the bus number')
  }

  // share: copy link, decode, verify it round-trips the state
  document.getElementById('btn-share').click()
  await wait(200)
  const sharedUrl = window.__shared
  const share = new URL(sharedUrl)
  const s = share.searchParams.get('s')
  console.log('SHARE URL:', sharedUrl.slice(0, 90) + '… (' + sharedUrl.length + ' chars)')
  if (!s) throw new Error('shared URL missing ?s= param')
  const sharedPayload = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
  if (sharedPayload.o?.atco !== '2290YHA00391') {
    throw new Error('shared origin atco mismatch: ' + JSON.stringify(sharedPayload.o).slice(0, 80))
  }

  // pick second stop ("via") — a stop the origin's buses actually reach. Try a
  // few candidates and keep the first that yields rows: arrow-suffixed stops are
  // directional, so a same-line stop can still be the wrong way round.
  document.getElementById('btn-set-to').click()
  await wait(100)
  input.value = 'north hull estate'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for north hull estate')
  const mes = await resultsTexts()
  console.log('TO SEARCH RESULTS:', mes[0]?.slice(0, 60))
  document.querySelector('#search-results .result').click() // open the "North Hull Estate" locality
  await waitForRows('stops in north hull estate')
  const viaRowsInList = [...document.querySelectorAll('#search-results .result')]
  let viaRow = null
  for (const want of ['🚏21st Avenue', '🚏1st Avenue', '🚏31st Avenue']) {
    const row = viaRowsInList.find((li) =>
      li.textContent.replace(/\s+/g, ' ').replace('＋', '').trim().startsWith(want)
    )
    if (!row) continue
    row.click() // second stop (≠ origin)
    await waitFor(
      () => document.querySelector('#to-row .to-chip') && document.querySelector('#dep-list .row'),
      20000,
      `via board for ${want}`
    )
    if (document.querySelectorAll('#dep-list .row').length) {
      viaRow = row
      break
    }
    console.log('via candidate', want, 'has no through buses — trying next')
  }
  if (!viaRow) throw new Error('no reachable second stop in North Hull Estate')

  const viaChip = document.querySelector('#to-row .to-chip')
  console.log('TO CHIP:', viaChip ? viaChip.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : 'MISSING')

  // assert every visible row's service is served at the via stop
  const via = getViaAtcoFromChip(viaChip)
  if (via) {
    const svc = await (await window.fetch(`${BASE}/api/stop-services?atco=` + via)).json()
    if (!Array.isArray(svc.services)) {
      throw new Error('stop-services API failed: ' + JSON.stringify(svc).slice(0, 120))
    }
    const viaSlugs = new Set(svc.services.map((s) => s.slug))
    const bad = [...document.querySelectorAll('#dep-list .row')]
      .map((li) => li.dataset.service)
      .filter((slug) => slug && !viaSlugs.has(slug))
    const viaRows = document.querySelectorAll('#dep-list .row').length
    console.log(
      'TO-FILTER ROWS:', viaRows,
      '| rows not calling at via:', bad.length ? bad.slice(0, 4).join(', ') : 'none'
    )
    if (bad.length) throw new Error('found rows that do not serve the via stop')
    if (!viaRows && !document.querySelector('#dep-list .empty'))
      throw new Error('expected either shared rows or a no-services empty state')

    await wait(2000) // let loadToArrivals join trips at the destination stop
    const arrCells = [...document.querySelectorAll('.row .arr')]
      .map((a) => a.textContent.trim())
      .filter(Boolean)
    console.log('ARRIVAL ESTIMATES:', arrCells.length ? arrCells.slice(0, 3).join(', ') : 'none')
  }

  const jfav = document.getElementById('btn-jfav')
  console.log('JFAV DISABLED:', jfav.disabled)
  if (jfav.disabled) throw new Error('journey star should enable once a destination is set')

  // ---- operator filter + swap + clear ----
  const opSelect = document.getElementById('op-select')
  await waitFor(() => opSelect?.options?.length >= 2, 15000, 'operator dropdown populated')
  const opCount = opSelect.options.length
  console.log('OPERATOR OPTIONS:', opCount)

  const originText = () => document.getElementById('origin-btn').textContent
  const chipText = () => document.querySelector('#to-row .to-chip')?.textContent.replace(/\s+/g, ' ').trim() || ''
  const beforeSwapOrigin = originText()
  document.getElementById('btn-swap').click()
  await waitFor(() => originText() !== beforeSwapOrigin, 8000, 'swap reversed origin')
  const swapped = originText()
  if (!swapped.includes('1st Avenue')) throw new Error('swap did not make to-stop the origin: ' + swapped)
  if (!chipText().includes('14th Avenue')) throw new Error('swap did not keep old origin as destination: ' + chipText())
  console.log('SWAP OK:', swapped, '|', chipText())

  document.getElementById('btn-clear').click()
  await waitFor(() => !!document.querySelector('.hero .btn-primary'), 8000, 'clear returned to hero')
  console.log('CLEAR OK: hero shown')

  // ---- hub group: switch origin to "Hull Interchange" (merged bays) ----
  document.getElementById('origin-btn').click()
  await wait(100)
  input.value = 'hull'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for hull')
  const hullLis = [...document.querySelectorAll('#search-results .result')]
  const hullIdx = hullLis.findIndex((li) => li.textContent.trim().startsWith('⌖Hull›'))
  console.log('HULL LOCALITY IDX:', hullIdx)
  if (hullIdx < 0) throw new Error('could not find Hull locality in search results')
  hullLis[hullIdx].click()
  await waitForRows('stops in hull (hub)')
  const groupLi = [...document.querySelectorAll('#search-results .result')]
    .find((li) => li.textContent.includes('Interchange') && li.textContent.includes('stops'))
  if (!groupLi) throw new Error('no "Hull Interchange" group card found')
  console.log('GROUP CARD:', groupLi.textContent.replace(/\s+/g, ' ').trim().slice(0, 50))
  groupLi.click()
  document.querySelector('.plan #plan-alone')?.click() // origin picked -> plan screen -> show alone
  await waitFor(
    () =>
      (document.querySelector('.board .stop-name')?.textContent || '').includes('Interchange') &&
      (document.querySelectorAll('#dep-list .row').length > 0 || document.querySelector('#dep-list .empty')),
    40000,
    'hub board'
  )

  const hubRows = document.querySelectorAll('#dep-list .row').length
  const bays = new Set(
    [...document.querySelectorAll('#dep-list .row')]
      .map((li) => li.querySelector('.depfrom')?.textContent.trim() || li.textContent.match(/Bay\s+\d+/)?.[0] || '')
      .filter(Boolean)
  )
  const emptyHub = document.querySelector('#dep-list .empty')
  const boardErr = document.querySelector('.board')?.dataset.error
  console.log('HUB ROWS:', hubRows, '| distinct bays:', bays.size ? [...bays].slice(0, 8).join(', ') : 'none')
  if (boardErr) console.log('HUB BOARD ERROR:', boardErr)
  if (hubRows < 2) throw new Error('expected merged multi-bay board (got ' + hubRows + ' rows)')
  if (bays.size < 1) throw new Error('expected bay column on hub rows')

  // ---- letter-stand group (generalization): Grimsby "Riverhead Exchange (Stand A..E)" ----
  document.getElementById('origin-btn').click()
  await wait(100)
  input.value = 'grimsby'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for grimsby')
  const grimLis = [...document.querySelectorAll('#search-results .result')]
  const grimIdx = grimLis.findIndex((li) => li.textContent.trim().startsWith('⌖Grimsby›'))
  console.log('GRIMSBY LOCALITY IDX:', grimIdx)
  if (grimIdx < 0) {
    console.log('GRIM TEXTS:', grimLis.length ? grimLis.slice(0, 10).map((l) => l.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)).join(' | ') : '(empty)')
    console.log('GRIM INPUT:', document.getElementById('search-input').value)
    console.log('DIALOG OPEN:', document.getElementById('search-dialog').open)
    throw new Error('could not find Grimsby locality')
  }
  grimLis[grimIdx].click()
  await waitForRows('stops in grimsby')
  const riverLi = [...document.querySelectorAll('#search-results .result')]
    .find((li) => li.textContent.includes('Riverhead') && li.textContent.includes('stops'))
  if (!riverLi) throw new Error('no "Riverhead Exchange" group card found')
  console.log('RIVERHEAD CARD:', riverLi.textContent.replace(/\s+/g, ' ').trim().slice(0, 50))
  riverLi.click()
  document.querySelector('.plan #plan-alone')?.click() // origin picked -> plan screen -> show alone
  await waitFor(
    () =>
      (document.querySelector('.board .stop-name')?.textContent || '').includes('Riverhead') &&
      (document.querySelectorAll('#dep-list .row').length > 0 || document.querySelector('#dep-list .empty')),
    40000,
    'riverhead board'
  )
  const riverRows = document.querySelectorAll('#dep-list .row').length
  const riverBays = new Set([...document.querySelectorAll('#dep-list .row .depfrom')].map((b) => b.textContent.trim()).filter(Boolean))
  console.log('RIVERHEAD ROWS:', riverRows, '| stands:', riverBays.size ? [...riverBays].slice(0, 6).join(', ') : 'none')
  if (!riverRows) throw new Error('expected departures at Riverhead Exchange')
  if (!riverBays.size) throw new Error('expected stand labels on Riverhead rows')

  // share again — this time the origin is a merged group; verify serialization
  document.getElementById('btn-share').click()
  await wait(200)
  const s2 = new URL(window.__shared).searchParams.get('s')
  if (!s2) throw new Error('shared URL (group) missing ?s=')
  const gPayload = JSON.parse(new TextDecoder().decode(b64urlToBytes(s2)))
  if (gPayload.o?.kind !== 'group' || !Array.isArray(gPayload.o.stops) || gPayload.o.stops.length < 2) {
    throw new Error('group did not round-trip through share URL: ' + JSON.stringify(gPayload.o).slice(0, 80))
  }
  console.log('GROUP SHARE OK: kind=group stops=' + gPayload.o.stops.length)

  // ---- directional street pair: Cottingham King Street ↑/↓ is one board ----
  // Regression: the 58 was invisible from "King Street ↑" because the ↓ kerb is
  // the one that goes to Sculcoates. Both kerbs must now be one selectable card.
  document.getElementById('origin-btn').click()
  await wait(100)
  input.value = 'cottingham'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for cottingham')
  const cotLis = [...document.querySelectorAll('#search-results .result')]
  const cotIdx = cotLis.findIndex((li) => li.textContent.replace(/\s+/g, ' ').trim().startsWith('⌖Cottingham'))
  if (cotIdx < 0) throw new Error('could not find Cottingham locality')
  cotLis[cotIdx].click()
  await waitForRows('stops in cottingham')

  const cotStops = [...document.querySelectorAll('#search-results .result')]
  const kingCard = cotStops.find((li) => li.textContent.includes('King Street') && li.textContent.includes('stops'))
  if (!kingCard) throw new Error('"Cottingham King Street" did not collapse into a group card')
  const kingSingles = cotStops.filter((li) => li.textContent.includes('King Street') && !li.textContent.includes('stops'))
  console.log('KING STREET CARD:', kingCard.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
  console.log('KING STREET LEFTOVER SINGLES:', kingSingles.length)
  if (kingSingles.length) {
    throw new Error('King Street still listed as separate stop rows: ' + kingSingles.map((l) => l.textContent.trim().slice(0, 30)).join(' / '))
  }
  const kingStops = Number(kingCard.textContent.match(/(\d+) stops/)?.[1] || 0)
  if (kingStops < 2) throw new Error('expected both King Street kerbs in one card (got ' + kingStops + ')')

  kingCard.click()
  document.querySelector('.plan #plan-alone')?.click()
  await waitFor(
    () =>
      (document.querySelector('.board .stop-name')?.textContent || '').includes('King Street') &&
      (document.querySelectorAll('#dep-list .row').length > 0 || document.querySelector('#dep-list .empty')),
    40000,
    'king street board'
  )
  const kingAlone = [...document.querySelectorAll('#dep-list .row')].filter((li) =>
    li.querySelector('.line')?.textContent.trim().startsWith('58')
  )
  const kingArrows = new Set(
    [...document.querySelectorAll('#dep-list .row .depfrom')]
      .map((b) => b.textContent.match(/[↑↓←→↗↘↙↖]$/)?.[0])
      .filter(Boolean)
  )
  console.log('KING STREET BOARD:', document.querySelectorAll('#dep-list .row').length, 'rows | 58s:', kingAlone.length, '| kerbs:', [...kingArrows].join(''))
  if (!kingAlone.length) throw new Error('no 58 departures on the merged King Street board')

  // …and the destination that used to show "no bus right now" now resolves
  document.getElementById('btn-set-to').click()
  await wait(100)
  input.value = 'sculcoates'
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await waitForRows('search results for sculcoates')
  const sculLis = [...document.querySelectorAll('#search-results .result')]
  const sculIdx = sculLis.findIndex((li) => li.textContent.replace(/\s+/g, ' ').trim().startsWith('⌖Sculcoates'))
  if (sculIdx < 0) throw new Error('could not find Sculcoates locality')
  sculLis[sculIdx].click()
  await waitForRows('stops in sculcoates')
  const hildaRow = [...document.querySelectorAll('#search-results .result')].find((li) =>
    li.textContent.replace(/\s+/g, ' ').replace('＋', '').trim().startsWith('🚏St Hilda Street')
  )
  if (!hildaRow) throw new Error('no St Hilda Street stop row in Sculcoates')
  hildaRow.click()
  await waitFor(
    () => document.querySelector('#to-row .to-chip'),
    20000,
    'st hilda chip'
  )
  await wait(2500)
  const hilda58 = [...document.querySelectorAll('#dep-list .row')].filter((li) =>
    li.querySelector('.line')?.textContent.trim().startsWith('58')
  )
  console.log(
    'KING ST → ST HILDA 58s:', hilda58.length,
    '|', hilda58.map((li) => li.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)).join(' || ').slice(0, 140)
  )
  if (!hilda58.length) {
    throw new Error('still no 58 from King Street to St Hilda Street: ' + (document.querySelector('#dep-list .empty')?.textContent.trim().slice(0, 120) || 'empty board'))
  }
  for (const row of hilda58) {
    const from = row.querySelector('.depfrom')?.textContent || ''
    if (/↑/.test(from)) throw new Error('58 shown from the wrong-king kerb: ' + from)
  }

  // a merged group must also work as the *destination* (⇄ swaps the two)
  document.getElementById('btn-swap').click()
  await waitFor(
    () => (document.querySelector('.board .stop-name')?.textContent || '').includes('St Hilda Street'),
    20000,
    'swapped to st hilda origin'
  )
  await wait(2500)
  const groupChip = document.querySelector('#to-row .to-chip')
  console.log('GROUP AS DESTINATION:', groupChip?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
  if (!groupChip?.textContent.includes('King Street')) throw new Error('swap lost the King Street group destination')
  if (!/3 stops/.test(groupChip.textContent)) throw new Error('group destination chip does not say how many stops')
  const swappedRows = document.querySelectorAll('#dep-list .row').length
  console.log('GROUP-DEST ROWS:', swappedRows)
  if (!swappedRows) {
    throw new Error('group destination filtered everything away: ' + (document.querySelector('#dep-list .empty')?.textContent.trim().slice(0, 120) || 'empty board'))
  }

  console.log('CLIENT ERRORS:', errors.length ? errors.join('\n  ') : 'none')
}

main()
  .then(() => {
    console.log('E2E OK')
    process.exit(0)
  })
  .catch((err) => {
    console.error('E2E FAIL:', err.message)
    process.exit(1)
  })