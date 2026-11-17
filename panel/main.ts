// Baalda-style note tree. Clicking a note opens it in a main-area tab (the Baalda editor).
import type { NoteNode, Tree, Vault } from '../src/protocol'
import { folderColor } from './color'
import { narrow, norm } from './filter'

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4 12.5 3.5 3.5 0 0 0 6.5 19z"/>',
  newNote: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>',
  newFolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  folderPath: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 13h8M13 10l3 3-3 3"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  collapse: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
  openApp: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 17l2.6-6.1A2 2 0 0 1 7.4 10H21l-2.7 7.3A2 2 0 0 1 16.4 19H5a2 2 0 0 1-2-2z"/>',
  page: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>'
}
const svg = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const els = {
  vault: $<HTMLSelectElement>('vault'),
  tree: $<HTMLUListElement>('tree'),
  status: $('status'),
  error: $('error'),
  create: $<HTMLFormElement>('create'),
  name: $<HTMLInputElement>('name'),
  path: $('path'),
  filter: $<HTMLInputElement>('filter')
}
for (const [id, icon] of [
  ['refresh', 'refresh'],
  ['sync', 'cloud'],
  ['app', 'openApp'],
  ['new-note', 'newNote'],
  ['new-folder', 'newFolder'],
  ['delete', 'trash'],
  ['collapse', 'collapse'],
  ['change-path', 'folderPath']
] as const) $(id).innerHTML = svg(icon)

let vault = ''
let data: Tree | null = null
let selected = ''
let creating: 'note' | 'folder' = 'note'
const expanded = new Set<string>()
let query = ''

/** The label with the matched part marked, as safe DOM. */
function label(text: string): DocumentFragment {
  const f = document.createDocumentFragment()
  const i = query ? norm(text).indexOf(query) : -1
  // NFKC can change lengths; only mark when the normalized form lines up with the text.
  if (i < 0 || norm(text).length !== text.length) {
    f.append(text)
    return f
  }
  const mark = document.createElement('mark')
  mark.textContent = text.slice(i, i + query.length)
  f.append(text.slice(0, i), mark, text.slice(i + query.length))
  return f
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    els.error.hidden = true
    await fn()
  } catch (e) {
    els.error.textContent = e instanceof Error ? e.message : String(e)
    els.error.hidden = false
  }
}

function saveState(): void {
  void orca.storage.set('ui', { vault, expanded: [...expanded], selected }).catch(() => {})
}

function node(n: NoteNode, depth: number): HTMLLIElement {
  const li = document.createElement('li')
  const row = document.createElement('div')
  row.className = 'row' + (n.key === selected ? ' selected' : '')
  row.style.setProperty('--depth', String(depth))
  row.tabIndex = 0
  row.setAttribute('role', 'treeitem')
  row.dataset.key = n.key
  const open = expanded.has(n.key) || (query !== '' && n.kind === 'folder') // filtering shows every hit
  const icon =
    n.kind === 'folder'
      ? `<span class="icon folder" style="--c:${folderColor(n.key)}">${svg(open ? 'folderOpen' : 'folder')}</span>`
      : `<span class="icon file">${svg(n.kind === 'page' ? 'page' : 'file')}</span>`
  row.innerHTML =
    `<span class="chev">${n.kind === 'folder' ? svg('chevron') : ''}</span>${icon}<span class="label"></span>` +
    (n.sync === 'local' ? '' : `<span class="dot ${n.sync}" title="${n.sync === 'synced' ? '동기화됨' : '동기화 대기'}"></span>`)
  ;(row.querySelector('.label') as HTMLElement).append(label(n.label))
  li.append(row)
  if (n.kind === 'folder') {
    row.setAttribute('aria-expanded', String(open))
    if (open) li.classList.add('open')
    const ul = document.createElement('ul')
    ul.setAttribute('role', 'group')
    for (const c of n.children ?? []) ul.append(node(c, depth + 1))
    li.append(ul)
  }
  return li
}

function find(items: NoteNode[], key: string): NoteNode | undefined {
  for (const n of items) {
    if (n.key === key) return n
    const hit = n.children && find(n.children, key)
    if (hit) return hit
  }
}

function render(): void {
  // Rebuilding drops the focused row: give focus back to the selection so the arrow keys keep working.
  const focused = els.tree.contains(document.activeElement)
  build()
  if (focused) els.tree.querySelector<HTMLElement>('.row.selected')?.focus()
}

function build(): void {
  els.tree.replaceChildren()
  if (!data) return
  const items = query ? data.items.map((n) => narrow(n, query)).filter((n): n is NoteNode => n !== null) : data.items
  if (items.length === 0) {
    els.tree.innerHTML = `<li class="empty">${query ? '일치하는 노트가 없습니다' : '노트가 없습니다'}</li>`
  } else for (const n of items) els.tree.append(node(n, 0))
  $<HTMLButtonElement>('delete').disabled = !selected || selected.endsWith('/') || !find(data.items, selected)
  els.status.textContent = !data.remote ? '로컬' : data.pending.length ? `대기 ${data.pending.length}` : ''
}

function showPath(): void {
  // ‎ keeps a leading drive letter on the left of the rtl-truncated line.
  els.path.textContent = vault ? '‎' + vault : '볼트 없음'
  els.path.title = vault
}

const refresh = () =>
  guard(async () => {
    showPath()
    if (!vault) return
    data = await orca.plugin.request('notes.tree', { vault })
    render()
  })

async function activate(key: string): Promise<void> {
  const n = data && find(data.items, key)
  if (!n) return
  selected = key
  if (n.kind === 'folder') {
    if (expanded.has(key)) expanded.delete(key)
    else expanded.add(key)
    render()
  } else {
    render()
    await guard(async () => {
      await orca.plugin.request('note.open', { vault, path: key })
    })
  }
  saveState()
}

els.tree.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
  if (row?.dataset.key) void activate(row.dataset.key)
})
// On the document, not the tree: with nothing focused (the panel just opened, a dialog closed)
// the arrows start from the selected row.
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  const free = t === document.body || t === document.documentElement
  const row = t.closest<HTMLElement>('.row') ?? (free ? els.tree.querySelector<HTMLElement>('.row.selected') : null)
  if ((row || free) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    // Rows inside a collapsed folder are display:none: skip them.
    const rows = Array.from(els.tree.querySelectorAll<HTMLElement>('.row')).filter((r) => r.offsetParent !== null)
    const next = row ? rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)] : rows[0]
    if (!next?.dataset.key) return
    row?.classList.remove('selected')
    next.classList.add('selected')
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
    selected = next.dataset.key
    $<HTMLButtonElement>('delete').disabled = selected.endsWith('/')
    saveState()
  }
  if (row?.dataset.key && e.key === 'Delete') {
    selected = row.dataset.key
    render()
    startDelete()
  }
  if (row?.dataset.key && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    void activate(row.dataset.key)
  }
})

els.vault.addEventListener('change', () => {
  vault = els.vault.value
  selected = ''
  expanded.clear()
  saveState()
  void refresh()
})
$('refresh').addEventListener('click', () => void refresh())
els.filter.addEventListener('input', () => {
  query = norm(els.filter.value.trim())
  render()
})
els.filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.filter.value = ''
    query = ''
    render()
  }
})
$('sync').addEventListener('click', () =>
  guard(async () => {
    const btn = $<HTMLButtonElement>('sync')
    btn.disabled = true
    try {
      const r = await orca.plugin.request('sync.run', { vault })
      if (!r.started) btn.title = r.running ? 'Baalda 앱이 실행 중이라 이미 동기화되고 있습니다' : '동기화'
      await refresh()
    } finally {
      btn.disabled = false
    }
  })
)
$('app').addEventListener('click', () => guard(async () => void (await orca.plugin.request('app.show'))))
$('collapse').addEventListener('click', () => {
  expanded.clear()
  saveState()
  render()
})

function startCreate(kind: 'note' | 'folder'): void {
  creating = kind
  els.create.hidden = false
  els.name.value = ''
  els.name.placeholder = kind === 'note' ? '새 노트 이름' : '새 폴더 이름'
  els.name.focus()
}
$('new-note').addEventListener('click', () => startCreate('note'))
$('new-folder').addEventListener('click', () => startCreate('folder'))
els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.create.hidden = true
})
els.create.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = els.name.value.trim()
  if (!name) return
  // Into the selected folder, or the selected note's folder.
  const folder = selected.endsWith('/') ? selected : selected.slice(0, selected.lastIndexOf('/') + 1)
  void guard(async () => {
    const { path } = await orca.plugin.request('note.create', { vault, folder, name, kind: creating })
    els.create.hidden = true
    if (folder) expanded.add(folder)
    await refresh()
    await activate(path)
  })
})

// Delete asks first in a <dialog>: the panel's sandbox may not allow confirm().
function startDelete(): void {
  const n = data && find(data.items, selected)
  if (!n || n.kind === 'folder') return
  $('confirm-text').textContent = `'${n.label}' 노트를 삭제할까요? (휴지통으로 이동)`
  const dlg = $<HTMLDialogElement>('confirm')
  dlg.returnValue = ''
  dlg.showModal()
  $('confirm-no').focus()
}
$('delete').addEventListener('click', startDelete)
$('confirm').addEventListener('close', () => {
  if ($<HTMLDialogElement>('confirm').returnValue !== 'yes') return
  const path = selected
  void guard(async () => {
    await orca.plugin.request('note.delete', { vault, path })
    selected = ''
    saveState()
    await refresh()
  })
})

// The Baalda tab moved to another note (a followed link): select it and open its folders.
orca.plugin.on('note.shown', (p) => {
  if (p.vault !== vault || p.path === selected) return
  selected = p.path
  const parts = p.path.split('/')
  for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/') + '/')
  saveState()
  render()
})

// Vault path: shown above the picker; "change" takes any Baalda vault folder by path.
$('change-path').addEventListener('click', () =>
  guard(async () => {
    const btn = $<HTMLButtonElement>('change-path')
    btn.disabled = true
    try {
      // The person may take a while in the dialog: allow the longest request Orca permits.
      const { vault: v } = await orca.plugin.request('vault.pick', { initial: vault }, { timeoutMs: 120000 })
      if (!v) return
      if (!Array.from(els.vault.options).some((o) => o.value === v.path))
        els.vault.append(Object.assign(document.createElement('option'), { value: v.path, textContent: v.name }))
      els.vault.value = v.path
      els.vault.dispatchEvent(new Event('change'))
    } finally {
      btn.disabled = false
    }
  })
)

// The sync button's run: Baalda hidden while it uploads, closed when done.
orca.plugin.on('sync.status', (p) => {
  if (p.vault !== vault) return
  const btn = $<HTMLButtonElement>('sync')
  btn.disabled = p.state === 'syncing'
  btn.title = p.message
  els.status.textContent = p.state === 'syncing' ? '동기화 중' : ''
  if (p.state !== 'syncing') void refresh()
  if (p.state === 'timeout') {
    els.error.textContent = p.message
    els.error.hidden = false
  }
})

orca.plugin.on('notes.changed', (p) => {
  if (p.vault === vault) void refresh()
})

void guard(async () => {
  const saved = ((await orca.storage.get('ui').catch(() => null)) ?? {}) as {
    vault?: string
    expanded?: string[]
    selected?: string
  }
  const { vaults, last } = await orca.plugin.request('vaults.list')
  els.vault.replaceChildren(
    ...vaults.map((v: Vault) => Object.assign(document.createElement('option'), { value: v.path, textContent: v.name }))
  )
  if (vaults.length === 0) {
    els.tree.innerHTML = '<li class="empty">Baalda 볼트가 없습니다.<br />Baalda 앱에서 볼트를 먼저 여세요.</li>'
    return
  }
  const has = (p?: string | null) => !!p && vaults.some((v: Vault) => v.path === p)
  vault = has(saved.vault) ? saved.vault! : has(last) ? last! : vaults[0].path
  if (vault === saved.vault) {
    for (const k of saved.expanded ?? []) expanded.add(k)
    selected = saved.selected ?? ''
  }
  els.vault.value = vault
  await refresh()
})
