import { registerSW } from 'virtual:pwa-register'
import { getState, setOrigin, setToStop, setDestination, setOperator, clearOrigin, getFavourites, removeFavourite, getFavJourneys, removeFavJourney, sharedStateFromUrl } from './store.js'
import { bootBoard, setReplaceOriginHandler } from './board.js'
import { openSearch, initSearch, closeSearch } from './search.js'
import { initManage, openManage } from './manage.js'

registerSW({
  immediate: true,
  onNeedRefresh() {
    if (!document.getElementById('search-dialog')?.open) location.reload()
  },
})

const app = document.getElementById('app')
const originBtn = document.getElementById('origin-btn')

function renderHeader() {
  const { origin, toStop } = getState()
  if (origin) {
    const glyph = origin.kind === 'group' ? '🏛' : '🚏'
    const tGlyph = toStop && toStop.kind === 'group' ? '🏛' : '🚏'
    originBtn.textContent = toStop
      ? `${glyph} ${origin.label} → ${tGlyph} ${toStop.label}`
      : `${glyph} ${origin.label}`
    originBtn.title = toStop
      ? 'Change departure point (click to change)'
      : 'Change starting stop (click to change)'
  } else {
    originBtn.textContent = 'Choose your stop'
  }
}

setReplaceOriginHandler(() => {
  openSearch((stop) => {
    setOrigin(stop)
    closeSearch()
    boot()
  })
})

function boot() {
  let { origin } = getState()
  const shared = sharedStateFromUrl()
  if (shared?.origin) {
    setOrigin(shared.origin)
    origin = shared.origin
    if (shared.toStop) setToStop(shared.toStop)
    if (shared.destination) setDestination(shared.destination)
    if (shared.operator) setOperator(shared.operator)
  }
  renderHeader()
  if (origin) {
    if (getState().toStop) {
      bootBoard(app, origin)
    } else {
      renderPlan(origin)
    }
  } else {
    renderHero()
  }
}

function renderPlan(origin) {
  const glyph = origin.kind === 'group' ? '🏛' : '🚏'
  const label = `${glyph} ${origin.label}${origin.kind === 'group' ? '' : ` · ${origin.atco}`}`
  app.innerHTML = `<section class="plan">
      <span class="plan-kicker">Plan a journey</span>
      <div class="plan-step">
        <span class="plan-num">1</span>
        <div class="plan-body">
          <span class="plan-label">Departure point</span>
          <button class="plan-btn" id="plan-origin" type="button">${escapeHtml(label)}</button>
        </div>
      </div>
      <div class="plan-arrow">▼</div>
      <div class="plan-step">
        <span class="plan-num">2</span>
        <div class="plan-body plan-body-goal">
          <span class="plan-label">Destination</span>
          <button class="btn-primary" id="plan-to" type="button">＋ Choose destination…</button>
        </div>
      </div>
      <button class="btn-ghost" id="plan-alone" type="button">Just show all departures from ${escapeHtml(origin.label)}</button>
    </section>`
  app.querySelector('#plan-origin').addEventListener('click', () => originBtn.click())
  app.querySelector('#plan-to').addEventListener('click', () =>
    openSearch((stop) => {
      setToStop(stop)
      closeSearch()
      boot()
    }, 'to'))
  app.querySelector('#plan-alone').addEventListener('click', () => {
    closeSearch()
    bootBoard(app, getState().origin)
  })
}

function renderHero() {
  const favs = getFavourites()
  const journeys = getFavJourneys()
  app.innerHTML = `<section class="hero">
      <h1>Which bus?</h1>
      <p>Pick where you’re leaving from, set your destination, and see the buses that get you there. You can filter by bus company (return tickets!), save named journeys, and bookmark favourite stops.</p>
      <button class="btn-primary" type="button">1 · Choose departure point</button>
      ${journeys.length ? `<div class="hero-section"><h2>Saved journeys</h2><div class="fav-row">${journeys.map((j, i) => journeyChip(j, i)).join('')}</div></div>` : ''}
      ${favs.length ? `<div class="hero-section"><h2>Favourite stops</h2><div class="fav-row">${favs.map((f, i) => favChip(f, i)).join('')}</div></div>` : ''}
    </section>`
  app.querySelector('.btn-primary').addEventListener('click', () => openSearch(firstRun))
  for (const chip of app.querySelectorAll('.fav-chip[data-jf]')) {
    const j = getFavJourneys()[Number(chip.dataset.jf)]
    if (!j) continue
    chip.querySelector('.fav-go')?.addEventListener('click', () => {
      closeSearch()
      setOrigin(j.origin)
      setToStop(j.toStop)
      if (j.destination) setDestination(j.destination)
      if (j.operator) setOperator(j.operator)
      boot()
    })
    chip.querySelector('.fav-x')?.addEventListener('click', () => {
      removeFavJourney(j.origin, j.toStop)
      renderHero()
    })
  }
  for (const btn of app.querySelectorAll('.fav-chip:not([data-jf])')) {
    btn.querySelector('.fav-go')?.addEventListener('click', () => {
      const chos = getFavourites()[Number(btn.dataset.fav)]
      if (!chos) return
      closeSearch()
      firstRun(chos)
    })
    btn.querySelector('.fav-x')?.addEventListener('click', () => {
      const chos = getFavourites()[Number(btn.dataset.fav)]
      if (!chos) return
      removeFavourite(chos)
      renderHero()
    })
  }
}

function journeyChip(j, i) {
  return `<button class="fav-chip journey" type="button" data-jf="${i}">
    <span class="fav-go">★ ${escapeHtml(j.name)}<small>${escapeHtml(j.origin.label)} → ${escapeHtml(j.toStop.label)}</small></span>
    <span class="fav-x" title="Remove">✕</span>
  </button>`
}

function favChip(f, i) {
  const glyph = f.kind === 'group' ? '🏛' : '🚏'
  return `<button class="fav-chip" type="button" data-fav="${i}">
    <span class="fav-go">★ ${glyph} ${escapeHtml(f.label)}</span>
    <span class="fav-x" title="Remove">✕</span>
  </button>`
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function firstRun(stop) {
  setOrigin(stop)
  closeSearch()
  boot()
}

originBtn.addEventListener('click', () => {
  if (getState().origin) {
    openSearch((stop) => {
      setOrigin(stop)
      closeSearch()
      boot()
    })
  } else {
    openSearch(firstRun)
  }
})

originBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!getState().origin) return
  if (window.confirm('Clear saved stop?')) {
    clearOrigin()
    boot()
  }
})

initSearch()
initManage()
document.getElementById('manage-btn').addEventListener('click', openManage)
document.addEventListener('whichbus:places', () => {
  renderHeader()
  if (!getState().origin) renderHero()
})
document.addEventListener('whichbus:reboot', () => boot())
boot()