import { getGroups, saveGroup, removeGroup, resolveGroup, exportData, importData } from './store.js'
import { searchAll } from './api.js'
import { groupSearchResults } from './search.js'
import { escapeHtml } from './html.js'

let dialog = null
let draft = null // { id?, name, members:[] }
let pending = 0

function el(id) {
  return dialog?.querySelector('#' + id) || null
}

export function initManage() {
  dialog = document.getElementById('manage-dialog')
  if (!dialog) return
  dialog.querySelector('#manage-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close()
  })
}

export function openManage() {
  if (!dialog) initManage()
  if (!dialog) return
  draft = null
  renderList()
  if (!dialog.open) dialog.showModal()
}

function renderList() {
  draft = null
  const groups = getGroups()
  const rows = groups.length
    ? groups
        .map((g) => {
          const n = resolveGroup(g)?.stops.length || 0
          return `<li class="manage-item" data-gid="${escapeHtml(g.id)}">
            <span class="mg-main">🏷 ${escapeHtml(g.name)}<small>${n} stop${n === 1 ? '' : 's'}</small></span>
            <button class="mini-btn" data-edit="${escapeHtml(g.id)}" type="button">Edit</button>
            <button class="icon-btn small" data-del="${escapeHtml(g.id)}" type="button" aria-label="Delete group">✕</button>
          </li>`
        })
        .join('')
    : '<li class="empty">No groups yet. Make one like “Home” from the stops near you.</li>'

  dialog.querySelector('#manage-title').textContent = 'My places'
  const body = dialog.querySelector('#manage-body')
  body.innerHTML = `
    <section class="manage-section">
      <h3>My groups</h3>
      <ul class="manage-list" id="group-list">${rows}</ul>
      <button class="btn-primary" id="group-new" type="button">＋ New group</button>
    </section>
    <section class="manage-section">
      <h3>Backup &amp; sync</h3>
      <p class="manage-note">Export everything to a JSON file, or import one from another device. Importing <b>merges</b> — nothing local is removed.</p>
      <div class="manage-io">
        <button class="btn-ghost" id="export-btn" type="button">⬇ Export JSON</button>
        <label class="btn-ghost" for="import-input">⬆ Import JSON</label>
        <input id="import-input" type="file" accept="application/json,.json" hidden />
      </div>
      <p class="manage-status" id="manage-status"></p>
    </section>`

  body.querySelector('#group-new').addEventListener('click', () => openEditor(null))
  for (const btn of body.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', () => openEditor(getGroups().find((g) => g.id === btn.dataset.edit)))
  }
  for (const btn of body.querySelectorAll('[data-del]')) {
    btn.addEventListener('click', () => {
      const g = getGroups().find((x) => x.id === btn.dataset.del)
      if (!g) return
      if (window.confirm(`Delete “${g.name}”?`)) {
        removeGroup(g.id)
        notify()
        renderList()
      }
    })
  }
  body.querySelector('#export-btn').addEventListener('click', doExport)
  body.querySelector('#import-input').addEventListener('change', doImport)
}

function openEditor(g) {
  draft = g ? { id: g.id, name: g.name, members: g.members.slice() } : { name: '', members: [] }
  renderEditor()
}

function memberStop(m) {
  return m.kind === 'group' ? (m.stops?.length || 0) : 1
}

function renderEditor(msg) {
  dialog.querySelector('#manage-title').textContent = draft.id ? 'Edit group' : 'New group'
  const body = dialog.querySelector('#manage-body')
  const total = draft.members.reduce((n, m) => n + memberStop(m), 0)
  body.innerHTML = `
    <section class="manage-section">
      <label class="manage-field">
        <span>Group name</span>
        <input id="group-name" type="text" maxlength="40" placeholder="Home, Work, Gym…" value="${escapeHtml(draft.name)}" />
      </label>
      <h3>Stops in this group <small>${total}</small></h3>
      <ul class="manage-list" id="member-list">
        ${draft.members.length
          ? draft.members.map((m, i) => memberRow(m, i)).join('')
          : '<li class="empty">No stops yet — search below to add some.</li>'}
      </ul>
      <h3>Add stops</h3>
      <input id="member-search" type="search" placeholder="Search for a stop or bus group…" autocomplete="off" />
      <ul class="manage-list manage-results" id="member-results"></ul>
      <p class="manage-status" id="editor-status">${msg ? escapeHtml(msg) : ''}</p>
      <div class="manage-actions">
        <button class="btn-primary" id="group-save" type="button">Save group</button>
        <button class="btn-ghost" id="group-cancel" type="button">Cancel</button>
      </div>
    </section>`

  const nameInput = body.querySelector('#group-name')
  const searchBox = body.querySelector('#member-search')

  nameInput.addEventListener('input', () => { draft.name = nameInput.value })

  for (const btn of body.querySelectorAll('[data-rm]')) {
    btn.addEventListener('click', () => {
      draft.members.splice(Number(btn.dataset.rm), 1)
      renderEditor()
    })
  }

  let debounce = 0
  searchBox.addEventListener('input', () => {
    clearTimeout(debounce)
    const q = searchBox.value.trim()
    const list = body.querySelector('#member-results')
    if (!q) {
      list.replaceChildren()
      return
    }
    const mine = ++pending
    list.innerHTML = '<li class="empty">Searching…</li>'
    debounce = setTimeout(async () => {
      try {
        const res = await searchAll(q, 20)
        if (mine !== pending) return
        const items = groupSearchResults(res).filter((it) => it.type === 'stop' || it.type === 'group')
        list.replaceChildren()
        if (!items.length) {
          list.innerHTML = '<li class="empty">No stops match.</li>'
          return
        }
        for (const it of items) {
          const li = document.createElement('li')
          const glyph = it.type === 'group' ? '🏛' : '🚏'
          li.className = 'result'
          li.innerHTML = `<span class="r-icon">${glyph}</span><span class="r-main">${escapeHtml(it.label)}${
            it.type === 'group' ? `<small class="r-lines">${it.stops.length} stops</small>` : ''
          }</span><span class="r-cta">＋</span>`
          li.addEventListener('click', () => {
            draft.members.push(toMember(it))
            renderEditor()
          })
          list.appendChild(li)
        }
      } catch {
        if (mine === pending) list.innerHTML = '<li class="empty">Search failed.</li>'
      }
    }, 200)
  })

  body.querySelector('#group-save').addEventListener('click', () => {
    draft.name = nameInput.value
    const saved = saveGroup(draft)
    if (!saved) {
      body.querySelector('#editor-status').textContent = 'Give the group a name and at least one stop.'
      return
    }
    notify()
    renderList()
  })
  body.querySelector('#group-cancel').addEventListener('click', renderList)
}

function memberRow(m, i) {
  const name = m.kind === 'group' ? `🏛 ${m.label}` : m.label
  const note = m.kind === 'group' ? `bus group · ${m.stops?.length || 0} stops` : m.atco
  return `<li class="manage-member">
    <span class="r-main">${escapeHtml(name)}<small class="r-lines">${escapeHtml(note || '')}</small></span>
    <button class="icon-btn small" data-rm="${i}" type="button" aria-label="Remove">✕</button>
  </li>`
}

function toMember(it) {
  if (it.type === 'group') {
    return { kind: 'group', label: it.label, stops: (it.stops || []).map((s) => ({ atco: s.atco, label: s.label, lines: s.lines || [] })) }
  }
  return { kind: 'stop', atco: it.atco, label: it.label, lines: it.lines || [] }
}

function doExport() {
  const data = exportData()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `whichbus-favourites-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  setStatus('Exported your places, saved journeys and groups.')
}

async function doImport(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const data = JSON.parse(await file.text())
    const counts = importData(data, { merge: true })
    notify()
    renderList()
    setStatus(`Imported — now ${counts.favourites} favourites, ${counts.favJourneys} journeys, ${counts.groups} groups.`)
  } catch (err) {
    setStatus(`Couldn’t import: ${err.message}`)
  }
}

function setStatus(msg) {
  const s = dialog?.querySelector('#manage-status')
  if (s) s.textContent = msg
}

function notify() {
  document.dispatchEvent(new Event('whichbus:places'))
}

