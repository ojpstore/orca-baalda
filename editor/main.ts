// The single Baalda tab. Its document is the view file `{ vault, path }` the panel points at the
// clicked note; the note itself is read and written through the worker. Baalda's desktop app
// syncs the note from disk.
import { marked } from './vendor/marked.js'
import { GROUPS } from './vendor/emoji.js'
import type { NoteNode } from '../src/protocol'
import { continueList, indentLines, pickNotes, wikiQuery, type Edit } from './text'

const title = document.getElementById('title') as HTMLElement
const backBtn = document.getElementById('back') as HTMLButtonElement
const fwdBtn = document.getElementById('fwd') as HTMLButtonElement
const conflict = document.getElementById('conflict') as HTMLElement
const view = document.getElementById('view') as HTMLElement
const source = document.getElementById('source') as HTMLTextAreaElement
const mode = document.getElementById('mode') as HTMLButtonElement
const state = document.getElementById('state') as HTMLElement
const page = document.getElementById('page') as HTMLIFrameElement
const tools = document.getElementById('tools') as HTMLElement
const emoji = document.getElementById('emoji') as HTMLElement
const main = document.querySelector('main') as HTMLElement
const top = document.getElementById('top') as HTMLButtonElement

main.addEventListener('scroll', () => (top.hidden = main.scrollTop < 200), { passive: true })
top.addEventListener('click', () => main.scrollTo({ top: 0, behavior: 'smooth' }))
const emojiBtn = tools.querySelector('[data-t="emoji"]') as HTMLButtonElement

// Read the note aloud. The worker speaks (Windows' Korean voice, repeating): Orca drops this frame
// when its tab is hidden, so speech here would die. Only the stop button stops it.
const speak = document.getElementById('speak') as HTMLButtonElement
let reading = false
/** While reading the button stays visible (as 정지), even in edit mode or on an HTML page. */
function syncSpeak(): void {
  speak.textContent = reading ? '정지' : '읽기'
  speak.hidden = !reading && (!target || editing || isPage(target))
}
function setReading(on: boolean): void {
  reading = on
  syncSpeak()
}
speak.addEventListener('click', () => {
  if (reading) {
    void orca.plugin.request('speech.stop')
    return setReading(false)
  }
  view.classList.add('tts') // leave out copy buttons and properties
  const text = view.innerText
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣]/gu, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
  view.classList.remove('tts')
  if (!text) return
  setReading(true)
  orca.plugin.request('speech.start', { text }).catch((e) => {
    setReading(false)
    state.textContent = String(e?.message ?? e)
  })
})
orca.plugin.on('speech.ended', () => setReading(false))
// A frame recreated while speech goes on must still show the stop button.
void orca.plugin.request('speech.state').then((r) => setReading(r.on))

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Marks a [[wikilink]] turned into a Markdown link; the target follows, URI-encoded. */
const WIKI = '#wikilink:'
const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i

// Notes can come from teammates: never render their raw HTML or script URLs.
marked.use({
  renderer: {
    html: (t: { text: string }) => escape(t.text),
    // Web images load as is; a vault image waits for the worker to read it (see hydrateImages).
    image: (t: { href: string; text: string }) =>
      /^https?:/i.test(t.href)
        ? `<img src="${escape(t.href)}" alt="${escape(t.text)}">`
        : /^([a-z][a-z0-9+.-]*:|#)/i.test(t.href)
          ? escape(t.text)
          : `<img data-src="${escape(t.href)}" alt="${escape(t.text)}">`,
    // A link token's `text` is raw source: render its inline tokens so nested HTML stays escaped.
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, t: { href: string; tokens: unknown[] }) {
      const text = this.parser.parseInline(t.tokens)
      if (t.href.startsWith(WIKI)) return `<a href="#" class="wikilink" data-target="${escape(t.href.slice(WIKI.length))}">${text}</a>`
      if (/^(https?:|mailto:)/i.test(t.href)) return `<a href="${escape(t.href)}" data-external>${text}</a>`
      if (t.href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(t.href)) return text // anchors, other schemes
      return `<a href="#" class="wikilink" data-target="${escape(t.href)}">${text}</a>` // relative note link
    }
  }
})

export function render(md: string): string {
  let body = md
  let props = ''
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md) // Baalda properties
  if (fm) {
    props = `<div class="props">${escape(fm[1])}</div>`
    body = md.slice(fm[0].length)
  }
  // [[Note]] / [[folder/Note|alias]] -> a link the click handler follows through the worker.
  // ![[shot.png]] -> an image the worker reads.
  body = body.replace(/(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, bang: string, name: string, alias?: string) =>
    bang && IMG.test(name.trim())
      ? `![${(name.trim().split('/').pop() ?? '').replace(/[[\]]/g, '')}](${encodeURIComponent(name.trim())})`
      : `[${(alias ?? name).replace(/[[\]]/g, '')}](${WIKI}${encodeURIComponent(name.trim())})`
  )
  return props + (body.trim() ? (marked.parse(body, { async: false }) as string) : '<p class="empty">빈 노트</p>')
}

type Target = { vault: string; path: string }
let target: Target | null = null
let text = ''
let lastSavedText = ''
let editing = false
/** The vault is locked in the panel: no edit button. */
let locked = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined

let history: Target[] = []
let histIdx = -1
let navigating = false
const sameTarget = (a: Target | null, b: Target | null) => !!a && !!b && a.vault === b.vault && a.path === b.path

function syncNav(): void {
  backBtn.disabled = histIdx <= 0
  fwdBtn.disabled = histIdx < 0 || histIdx >= history.length - 1
}

function recordHistory(t: Target | null): void {
  if (!t) return
  if (navigating) {
    navigating = false
    syncNav()
    return
  }
  if (sameTarget(history[histIdx] ?? null, t)) return
  history = history.slice(0, histIdx + 1)
  history.push(t)
  if (history.length > 50) history.shift()
  histIdx = history.length - 1
  syncNav()
}

function goHistory(delta: number): void {
  const nextIdx = histIdx + delta
  if (nextIdx < 0 || nextIdx >= history.length) return
  const dest = history[nextIdx]
  histIdx = nextIdx
  navigating = true
  syncNav()
  state.textContent = ''
  void orca.plugin.request('note.open', dest).catch((err: unknown) => {
    navigating = false
    state.textContent = err instanceof Error ? err.message : String(err)
  })
}

backBtn.addEventListener('click', () => goHistory(-1))
fwdBtn.addEventListener('click', () => goHistory(1))

/** Toggles the `idx`-th Markdown task checkbox outside YAML frontmatter and fenced code blocks. */
export function toggleTaskCheckbox(md: string, idx: number, checked: boolean): string {
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md)
  const head = fm ? fm[0] : ''
  const lines = (fm ? md.slice(head.length) : md).split('\n')
  let inFence = false
  let fenceChar = ''
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence[1][0]
      } else if (fence[1][0] === fenceChar) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s|$))/.exec(line)
    if (m) {
      if (seen === idx) {
        lines[i] = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, `$1${checked ? 'x' : ' '}$3`)
        return head + lines.join('\n')
      }
      seen++
    }
  }
  return md
}

function parse(raw: string): Target | null {
  try {
    const t = JSON.parse(raw) as Target
    return typeof t.vault === 'string' && typeof t.path === 'string' ? t : null
  } catch {
    return null
  }
}

const isPage = (t: Target | null) => !!t && /\.html?$/i.test(t.path)

function show(): void {
  title.textContent = target ? target.path.slice(target.path.lastIndexOf('/') + 1).replace(/\.(md|html?)$/i, '') : ''
  mode.hidden = !target || locked
  syncSpeak()
  page.hidden = editing || !isPage(target)
  view.hidden = editing || isPage(target)
  if (!target) view.innerHTML = '<p class="empty">Baalda 패널에서 노트를 선택하세요</p>'
  else if (editing) {
    // the textarea shows the source
  } else if (isPage(target)) page.srcdoc = withSdk(text) // HTML page (dashboard): sandboxed, own origin
  else {
    view.innerHTML = render(text)
    Array.from(view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).forEach((cb, i) => {
      cb.dataset.taskIdx = String(i)
      cb.disabled = locked
    })
    for (const pre of Array.from(view.querySelectorAll('pre'))) {
      const b = document.createElement('button')
      b.className = 'copy'
      b.textContent = '복사'
      // Wrapped, so the button stays put while a long line scrolls the pre sideways.
      const wrap = Object.assign(document.createElement('div'), { className: 'code' })
      pre.replaceWith(wrap)
      wrap.append(pre, b)
    }
    hydrateImages(target)
  }
  if (!find.hidden) step(0)
}

/** Vault images already read, by note and src; cleared when another note opens. */
const images = new Map<string, string>()
function hydrateImages(t: Target): void {
  for (const img of Array.from(view.querySelectorAll<HTMLImageElement>('img[data-src]'))) {
    let src = img.dataset.src ?? ''
    try {
      src = decodeURIComponent(src)
    } catch {
      // not encoded: use as written
    }
    const key = t.path + '\0' + src
    const hit = images.get(key)
    if (hit) {
      img.src = hit
      continue
    }
    void orca.plugin
      .request('note.image', { vault: t.vault, from: t.path, src })
      .then((r) => {
        const url = `data:${r.mime};base64,${r.data}`
        images.set(key, url)
        if (img.isConnected) img.src = url
      })
      .catch(() => (img.alt = `이미지를 불러올 수 없습니다: ${src}`))
  }
}

// Backlinks: notes that link to this one, in a collapsible area under the note.
const bl = document.getElementById('backlinks') as HTMLDetailsElement
const blList = document.getElementById('bl-list') as HTMLElement
const blCount = document.getElementById('bl-count') as HTMLElement
let blRun = 0
function loadBacklinks(): void {
  const t = target
  const mine = ++blRun
  if (!t) {
    bl.hidden = true
    return
  }
  void orca.plugin
    .request('note.backlinks', t)
    .then(({ paths }) => {
      if (mine !== blRun) return
      bl.hidden = false
      blCount.textContent = `(${paths.length})`
      blList.replaceChildren(
        ...paths.map((p) => {
          const b = Object.assign(document.createElement('button'), { textContent: p.replace(/\.(md|html?)$/i, ''), title: p })
          b.dataset.path = p
          const li = document.createElement('li')
          li.append(b)
          return li
        })
      )
    })
    .catch(() => {
      if (mine === blRun) bl.hidden = true
    })
}
blList.addEventListener('click', (e) => {
  const path = (e.target as HTMLElement).closest('button')?.dataset.path
  if (!path || !target) return
  state.textContent = ''
  void orca.plugin
    .request('note.open', { vault: target.vault, path })
    .catch((err: unknown) => (state.textContent = err instanceof Error ? err.message : String(err)))
})

// Ctrl+F: find in the note. The view highlights hits without touching the DOM; the editor selects them.
const find = document.getElementById('find') as HTMLElement
const findInput = find.querySelector('input') as HTMLInputElement
const findCount = find.querySelector('.count') as HTMLElement
let found: (Range | number)[] = []
/** The DOM lib types the registry without its Map methods. */
const marks = CSS.highlights as unknown as Map<string, Highlight>
let at = 0

// ponytail: a hit split across formatting (e.g. half **bold**) isn't found in the view; join text nodes if it matters.
function scan(): void {
  const q = findInput.value.toLowerCase()
  found = []
  marks.clear()
  if (!q) return
  if (editing) {
    const v = source.value.toLowerCase()
    for (let i = v.indexOf(q); i >= 0; i = v.indexOf(q, i + q.length)) found.push(i)
    return
  }
  if (view.hidden) return // HTML pages are a sandboxed frame
  const walk = document.createTreeWalker(view, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const v = n.nodeValue!.toLowerCase()
    for (let i = v.indexOf(q); i >= 0; i = v.indexOf(q, i + q.length)) {
      const r = new Range()
      r.setStart(n, i)
      r.setEnd(n, i + q.length)
      found.push(r)
    }
  }
  marks.set('find', new Highlight(...(found as Range[])))
}

/** Searches again (the note may have changed) and moves `d` hits from the current one. */
function step(d: number): void {
  scan()
  if (!found.length) {
    findCount.textContent = findInput.value ? '0/0' : ''
    return
  }
  at = (((at + d) % found.length) + found.length) % found.length
  findCount.textContent = `${at + 1}/${found.length}`
  const h = found[at]
  if (typeof h === 'number') {
    source.setSelectionRange(h, h + findInput.value.length)
    source.focus() // scrolls the textarea to the selection
    findInput.focus()
  } else {
    marks.set('find-now', new Highlight(h))
    h.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }
}

function openFind(): void {
  find.hidden = false
  findInput.focus()
  findInput.select()
  step(0)
}

function closeFind(): void {
  find.hidden = true
  marks.clear()
  if (editing) source.focus() // lands on the current hit, still selected
}

findInput.addEventListener('input', () => {
  at = 0
  step(0)
})
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeFind()
  }
})
find.addEventListener('mousedown', (e) => e.target !== findInput && e.preventDefault())
find.addEventListener('click', (e) => {
  const d = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.d
  if (d) (d === '0' ? closeFind() : step(Number(d)))
})

/** The sandboxed tab may be denied the async clipboard: fall back to a selection copy. */
async function copy(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: s })
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

/**
 * Baalda dashboards open notes through the SDK the Baalda app injects (`baalda.app.open({ path })`,
 * paths relative to the vault). This stand-in forwards those calls, and clicks on plain relative
 * links, to the tab, which follows them like wikilinks.
 */
const SDK = `<script>(() => {
  const open = (path) => parent.postMessage({ baalda: 'open', path: String(path) }, '*')
  window.baalda = { ready: Promise.resolve(), app: { open: async ({ path }) => open(path) } }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return
    const a = e.target.closest && e.target.closest('a[href]')
    const href = a && a.getAttribute('href')
    if (!href || /^([a-z][a-z0-9+.-]*:|#|[/])/i.test(href)) return
    e.preventDefault()
    open(href)
  })
})()<\/script>`

function withSdk(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  return head ? html.slice(0, head.index + head[0].length) + SDK + html.slice(head.index + head[0].length) : SDK + html
}

window.addEventListener('message', (e) => {
  const d = e.data as { baalda?: string; path?: unknown } | null
  if (e.source === page.contentWindow && d?.baalda === 'open' && typeof d.path === 'string') goto(d.path)
})

function goto(link: string): void {
  if (!target) return
  let to = link
  try {
    to = decodeURIComponent(link)
  } catch {
    // not encoded: use as written
  }
  state.textContent = ''
  void orca.plugin
    .request('note.goto', { vault: target.vault, from: target.path, target: to })
    .catch((err: unknown) => (state.textContent = err instanceof Error ? err.message : String(err)))
}

// Toggle checklist items directly from the view mode when the vault is unlocked.
view.addEventListener('change', (e) => {
  const cb = e.target as HTMLInputElement
  if (cb.tagName !== 'INPUT' || cb.type !== 'checkbox' || cb.dataset.taskIdx === undefined) return
  if (!target || locked) return
  const next = toggleTaskCheckbox(text, Number(cb.dataset.taskIdx), cb.checked)
  if (next === text) return
  text = next
  dirty = true
  void save()
})

// Follow note links inside the vault; open web links in the browser.
view.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.copy')
  if (btn) {
    const code = btn.parentElement?.querySelector('pre')?.textContent ?? ''
    void copy(code).then((ok) => {
      btn.textContent = ok ? '복사됨' : '복사 실패'
      setTimeout(() => (btn.textContent = '복사'), 1500)
    })
    return
  }
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  if (a.hasAttribute('data-external')) {
    void orca.shell?.openExternal(a.getAttribute('href') ?? '')
    return
  }
  if (a.dataset.target) goto(a.dataset.target)
})

/**
 * Orca refuses a frame request over 65,560 UTF-8 bytes ("message too large"), so long notes go in
 * parts. A UTF-16 unit is at most 3 bytes, so 16k units stay well under the cap with the path.
 */
const PART = 16_000
async function write(t: Target, all: string): Promise<void> {
  for (let offset = 0; ; ) {
    let end = Math.min(offset + PART, all.length)
    if (end < all.length && /[\uD800-\uDBFF]/.test(all[end - 1])) end-- // keep surrogate pairs whole
    const more = end < all.length
    await orca.plugin.request('note.write', { ...t, text: all.slice(offset, end), offset, more })
    if (!more) return
    offset = end
  }
}

// One save at a time: a write is several requests now, and two must not interleave their parts.
let saving = Promise.resolve()
function save(): Promise<void> {
  clearTimeout(timer)
  return (saving = saving.then(saveNow))
}

async function saveNow(): Promise<void> {
  if (!target || !dirty) return
  dirty = false
  const snapshot = text
  state.textContent = '저장 중…'
  try {
    await write(target, snapshot)
    lastSavedText = snapshot
    state.textContent = '저장됨'
  } catch (e) {
    dirty = true
    state.textContent = '저장 실패: ' + (e instanceof Error ? e.message : String(e))
  }
}

let loads = 0
async function load(next: Target | null): Promise<void> {
  const mine = ++loads
  await save() // never drop edits to the previous note
  const read = next ? await orca.plugin.request('note.read', next) : { text: '', locked: false }
  if (mine !== loads) return // a later click won while this read was in flight
  if (!sameTarget(next, target)) {
    images.clear()
    wikiKeys = null
  }
  target = next
  text = read.text
  lastSavedText = read.text
  locked = read.locked
  conflict.hidden = true
  recordHistory(next)
  if (locked && editing) setEditing(false)
  state.textContent = ''
  if (editing) source.value = text
  show()
  loadBacklinks()
}

document.getElementById('conflict-reload')!.addEventListener('click', () => {
  dirty = false
  conflict.hidden = true
  if (target) void load(target)
})
document.getElementById('conflict-keep')!.addEventListener('click', () => {
  conflict.hidden = true
  dirty = true
  state.textContent = '수정됨'
})

/** Replaces the selection through the editing command, so Ctrl+Z undoes it and `input` autosaves. */
function insert(t: string): void {
  source.focus()
  if (!(t ? document.execCommand('insertText', false, t) : document.execCommand('delete'))) {
    source.setRangeText(t, source.selectionStart, source.selectionEnd, 'end')
    source.dispatchEvent(new Event('input'))
  }
}

function wrap(before: string, after = before, placeholder = '텍스트'): void {
  const { selectionStart: s, selectionEnd: e, value } = source
  const sel = value.slice(s, e) || placeholder
  insert(before + sel + after)
  source.setSelectionRange(s + before.length, s + before.length + sel.length)
}

/** Toggles a prefix on every selected line; a heading replaces any other heading level. */
function prefix(p: string): void {
  const { selectionStart: s, value } = source
  const e = source.selectionEnd > s && value[source.selectionEnd - 1] === '\n' ? source.selectionEnd - 1 : source.selectionEnd
  const start = value.lastIndexOf('\n', s - 1) + 1
  const stop = value.indexOf('\n', e)
  const end = stop < 0 ? value.length : stop
  const lines = value.slice(start, end).split('\n')
  const on = lines.every((l) => l.startsWith(p))
  const out = lines.map((l) => (on ? l.slice(p.length) : p + (p[0] === '#' ? l.replace(/^#{1,6} /, '') : l))).join('\n')
  source.setSelectionRange(start, end)
  insert(out)
  source.setSelectionRange(start, start + out.length)
}

/** A newline when the cursor is mid-line, so a block starts on its own line. */
const nl = () => (source.selectionStart > 0 && source.value[source.selectionStart - 1] !== '\n' ? '\n' : '')
const block = (t: string) => insert(nl() + t)

const TOOLS: Record<string, () => void> = {
  h1: () => prefix('# '),
  h2: () => prefix('## '),
  h3: () => prefix('### '),
  bold: () => wrap('**'),
  italic: () => wrap('*'),
  strike: () => wrap('~~'),
  code: () => wrap('`', '`', 'code'),
  link: () => wrap('[', '](https://)', '링크'),
  ul: () => prefix('- '),
  ol: () => prefix('1. '),
  task: () => prefix('- [ ] '),
  quote: () => prefix('> '),
  block: () => wrap(nl() + '```\n', '\n```\n', ''),
  table: () => block('| 열 1 | 열 2 |\n| --- | --- |\n|  |  |\n'),
  hr: () => block('\n---\n'),
  emoji: () => toggleEmoji(emoji.hidden)
}

const groups = GROUPS.map(([name, icon, lines]) => ({
  name,
  icon,
  list: lines.split('\n').map((l) => {
    const [ch, label, ...tags] = l.split('\t')
    return { ch, label, search: [label, ...tags].join(' ').toLowerCase() }
  })
}))
const everyEmoji = groups.flatMap((g) => g.list)
const labelOf = new Map(everyEmoji.map((e) => [e.ch, e.label]))

const DEFAULT = '📌 ⭐ ✅ ❌ ⚠️ ❗ ❓ 💡 🔥 🚀 🎯 🏆 📝 📅 ⏰ 📎 🔗 📁 📊 💻 🐛 🔧 🔒 🔑 💰 🏠 ✈️ 🍀 🎉 ❤️ 👍 👀 🙂 😂 😢 😡 🤔 🙏 💪'.split(' ')
const USED = 'baalda.emoji.used'
// Per-viewer convenience only: blocked storage just means the defaults.
function used(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USED) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}
function remember(ch: string): void {
  const u = used()
  u[ch] = (u[ch] ?? 0) + 1
  try {
    localStorage.setItem(USED, JSON.stringify(u))
  } catch {
    // storage blocked
  }
}
function frequent(): string[] {
  const u = used()
  return [...new Set([...Object.keys(u).sort((a, b) => u[b] - u[a]), ...DEFAULT])].slice(0, 40)
}

const search = emoji.querySelector('input') as HTMLInputElement
const tabs = emoji.querySelector('.tabs') as HTMLElement
const list = emoji.querySelector('.list') as HTMLElement
const [big, name] = Array.from(emoji.querySelectorAll<HTMLElement>('.preview span'))
const IDLE: [string, string] = ['😊', '기분이 어떠세요?']

tabs.innerHTML = [['자주 사용', '🕒'], ...groups.map((g) => [g.name, g.icon])]
  .map(([n, i]) => `<button title="${n}" aria-label="${n}">${i}</button>`)
  .join('')

const section = (title: string, chars: string[]) =>
  `<h4>${title}</h4><div class="grid">${chars.map((c) => `<button aria-label="${escape(labelOf.get(c) ?? c)}">${c}</button>`).join('')}</div>`

function fill(): void {
  const q = search.value.trim().toLowerCase()
  const hits = q ? everyEmoji.filter((e) => e.search.includes(q)).map((e) => e.ch) : []
  list.innerHTML = !q
    ? section('자주 사용', frequent()) + groups.map((g) => section(g.name, g.list.map((e) => e.ch))).join('')
    : hits.length ? section('검색 결과', hits) : '<p class="none">검색 결과가 없습니다</p>'
  list.scrollTop = 0
  setTab(q ? -1 : 0)
}

function setTab(i: number): void {
  tabs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', i === j))
}

function setPreview([ch, label]: [string, string]): void {
  big.textContent = ch
  name.textContent = label
}

function toggleEmoji(open: boolean): void {
  if (open === !emoji.hidden) return
  emoji.hidden = !open
  emojiBtn.setAttribute('aria-expanded', String(open))
  if (!open) return
  const r = emojiBtn.getBoundingClientRect()
  emoji.style.top = `${tools.getBoundingClientRect().bottom + 4}px`
  emoji.style.left = `${Math.max(8, Math.min(r.left, innerWidth - emoji.offsetWidth - 8))}px`
  search.value = ''
  setPreview(IDLE)
  fill()
  search.focus()
}

search.addEventListener('input', fill)
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') list.querySelector<HTMLButtonElement>('.grid button')?.click()
})
tabs.addEventListener('mousedown', (e) => e.preventDefault())
tabs.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b) return
  const i = Array.from(tabs.children).indexOf(b)
  if (search.value) {
    search.value = ''
    fill()
  }
  list.scrollTop = list.querySelectorAll('h4')[i].offsetTop
})
list.addEventListener('scroll', () => {
  if (search.value.trim()) return
  let i = 0
  list.querySelectorAll('h4').forEach((h, j) => h.offsetTop <= list.scrollTop + 8 && (i = j))
  setTab(i)
})
list.addEventListener('mouseover', (e) => {
  const ch = (e.target as HTMLElement).closest('.grid button')?.textContent
  if (ch) setPreview([ch, labelOf.get(ch) ?? ''])
})
list.addEventListener('mouseleave', () => setPreview(IDLE))
// Picking keeps the picker open for more; the toolbar button, Escape or a click outside closes it.
list.addEventListener('mousedown', (e) => e.preventDefault())
list.addEventListener('click', (e) => {
  const ch = (e.target as HTMLElement).closest('.grid button')?.textContent
  if (!ch) return
  insert(ch)
  remember(ch)
})
document.addEventListener('mousedown', (e) => {
  const t = e.target as Node
  if (!emoji.hidden && !emoji.contains(t) && !emojiBtn.contains(t)) toggleEmoji(false)
})

tools.addEventListener('mousedown', (e) => e.preventDefault()) // keep the textarea's selection
tools.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.t
  if (t) TOOLS[t]?.()
})

function setEditing(on: boolean): void {
  editing = on
  mode.textContent = editing ? '보기' : '편집'
  source.hidden = !editing
  tools.hidden = !editing
  toggleEmoji(false)
  if (editing) {
    source.value = text
    source.focus()
  }
  if (!editing) void save()
  show()
}
mode.addEventListener('click', () => setEditing(!editing))
source.addEventListener('input', () => {
  text = source.value
  dirty = true
  state.textContent = '수정됨'
  clearTimeout(timer)
  timer = setTimeout(() => void save(), 800) // autosave: the tab's own file is only the pointer
  void updateWiki()
})

function apply(ed: Edit): void {
  source.setSelectionRange(ed.from, ed.to)
  insert(ed.text)
  if (ed.sel) source.setSelectionRange(...ed.sel)
}

// [[ autocomplete: a popup under the toolbar lists vault notes; picking one writes [[path]].
const wiki = document.getElementById('wiki') as HTMLElement
let wikiKeys: string[] | null = null
let wikiHits: string[] = []
let wikiAt = 0
let wikiFrom = 0

async function noteKeys(t: Target): Promise<string[]> {
  if (wikiKeys) return wikiKeys
  const flat = (ns: NoteNode[]): string[] => ns.flatMap((n) => (n.kind === 'folder' ? flat(n.children ?? []) : [n.key]))
  return (wikiKeys = flat((await orca.plugin.request('notes.tree', { vault: t.vault })).items))
}

function closeWiki(): void {
  wiki.hidden = true
}

function paintWiki(): void {
  wiki.replaceChildren(
    ...wikiHits.map((k, i) => {
      const b = document.createElement('button')
      b.className = i === wikiAt ? 'on' : ''
      b.dataset.i = String(i)
      const dir = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : ''
      b.append((k.split('/').pop() ?? k).replace(/\.(md|html?)$/i, ''))
      if (dir) b.append(Object.assign(document.createElement('small'), { textContent: dir }))
      return b
    })
  )
  wiki.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
}

async function updateWiki(): Promise<void> {
  const t = target
  if (!t || !editing || source.selectionStart !== source.selectionEnd || !wikiQuery(source.value, source.selectionStart)) return closeWiki()
  const keys = await noteKeys(t).catch(() => [] as string[])
  const q = source.selectionStart === source.selectionEnd && wikiQuery(source.value, source.selectionStart) // typing went on while the list loaded
  wikiHits = q ? pickNotes(keys, q.q) : []
  if (!q || !wikiHits.length) return closeWiki()
  wikiFrom = q.start
  wikiAt = 0
  paintWiki()
  wiki.style.top = `${tools.getBoundingClientRect().bottom + 4}px`
  wiki.style.left = '32px'
  wiki.hidden = false
}

function acceptWiki(i: number): void {
  const key = wikiHits[i]
  if (!key) return
  const caret = source.selectionStart
  source.setSelectionRange(wikiFrom, source.value.startsWith(']]', caret) ? caret + 2 : caret)
  insert(`[[${key.replace(/\.md$/i, '')}]]`)
  closeWiki()
}

wiki.addEventListener('mousedown', (e) => e.preventDefault()) // keep the textarea's caret
wiki.addEventListener('click', (e) => {
  const i = (e.target as HTMLElement).closest('button')?.dataset.i
  if (i !== undefined) acceptWiki(Number(i))
})
source.addEventListener('blur', closeWiki)

source.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return // Korean IME: Enter/Tab belong to the composition
  if (!wiki.hidden) {
    const n = wikiHits.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      wikiAt = (wikiAt + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return paintWiki()
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      return acceptWiki(wikiAt)
    }
    if (e.key === 'Escape') e.preventDefault()
    if (e.key.length > 1 && !['Shift', 'Backspace'].includes(e.key)) closeWiki()
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'Tab') {
    e.preventDefault()
    apply(indentLines(source.value, source.selectionStart, source.selectionEnd, e.shiftKey))
  } else if (e.key === 'Enter' && !e.shiftKey && source.selectionStart === source.selectionEnd) {
    const ed = continueList(source.value, source.selectionStart)
    if (ed) {
      e.preventDefault()
      apply(ed)
    }
  }
})

// Ctrl+V with an image on the clipboard: save it in the vault and link it. (Text pastes as usual.)
const PIECE = 36_000 // raw bytes per request: a multiple of 3, so the base64 parts join cleanly
const b64 = (blob: Blob) =>
  new Promise<string>((done, fail) => {
    const r = new FileReader()
    r.onload = () => done(String(r.result).split(',')[1] ?? '')
    r.onerror = () => fail(r.error)
    r.readAsDataURL(blob)
  })

async function pasteImage(file: File, t: Target): Promise<void> {
  state.textContent = '이미지 저장 중…'
  try {
    let link = ''
    for (let at = 0, sent = 0; at < file.size; at += PIECE) {
      const data = await b64(file.slice(at, at + PIECE))
      link = (await orca.plugin.request('note.attach', { vault: t.vault, from: t.path, mime: file.type, data, offset: sent, more: at + PIECE < file.size })).link
      sent += data.length
    }
    if (link && editing && sameTarget(target, t)) insert(`![](${link})`)
    state.textContent = link ? '이미지 추가됨' : ''
  } catch (e) {
    state.textContent = '이미지 저장 실패: ' + (e instanceof Error ? e.message : String(e))
  }
}

source.addEventListener('paste', (e) => {
  const cb = e.clipboardData
  if (!cb || !target || Array.from(cb.types).includes('text/plain')) return
  const file = Array.from(cb.items).find((i) => i.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(i.type))?.getAsFile()
  if (!file) return
  e.preventDefault()
  if (locked) state.textContent = '잠긴 볼트에는 이미지를 붙여넣을 수 없습니다'
  else void pasteImage(file, target)
})
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    goHistory(e.key === 'ArrowLeft' ? -1 : 1)
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void save()
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && (editing || !isPage(target))) {
    e.preventDefault()
    openFind()
  }
  if (e.key === 'Escape' && !emoji.hidden) {
    toggleEmoji(false)
    source.focus()
  }
  const key = editing && !e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && { b: 'bold', i: 'italic', k: 'link' }[e.key.toLowerCase()]
  if (key) {
    e.preventDefault()
    TOOLS[key]()
  }
})

// Locking the vault mid-edit saves what was typed and goes back to the view.
orca.plugin.on('vault.locked', (p) => {
  if (!target || p.vault !== target.vault) return
  locked = p.locked
  if (locked && editing) setEditing(false)
  else show()
})

// The note changed on disk (Baalda sync, another editor): reload in view mode, or warn if editing.
orca.plugin.on('notes.changed', () => {
  if (!target) return
  wikiKeys = null
  if (!editing) loadBacklinks() // while editing, each autosave would rescan the vault
  if (!dirty && !editing) {
    void load(target).catch(() => (state.textContent = '노트가 삭제되었거나 읽을 수 없습니다'))
    return
  }
  const cur = target
  void orca.plugin
    .request('note.read', cur)
    .then((r) => {
      if (sameTarget(target, cur) && r.text !== text && r.text !== lastSavedText) conflict.hidden = false
    })
    .catch(() => {})
})

const doc = await orca.document!.session<string>()
doc.onReplace((raw) => void load(parse(raw)))
await load(parse(doc.value))
