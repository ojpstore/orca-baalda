// The single Baalda tab. Its document is the view file `{ vault, path }` the panel points at the
// clicked note; the note itself is read and written through the worker. Baalda's desktop app
// syncs the note from disk.
import { marked } from './vendor/marked.js'
import type {} from '../src/protocol'

const title = document.getElementById('title') as HTMLElement
const view = document.getElementById('view') as HTMLElement
const source = document.getElementById('source') as HTMLTextAreaElement
const mode = document.getElementById('mode') as HTMLButtonElement
const state = document.getElementById('state') as HTMLElement
const page = document.getElementById('page') as HTMLIFrameElement

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Marks a [[wikilink]] turned into a Markdown link; the target follows, URI-encoded. */
const WIKI = '#wikilink:'

// Notes can come from teammates: never render their raw HTML or script URLs.
marked.use({
  renderer: {
    html: (t: { text: string }) => escape(t.text),
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
  body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name: string, alias?: string) =>
    `[${(alias ?? name).replace(/[[\]]/g, '')}](${WIKI}${encodeURIComponent(name.trim())})`
  )
  return props + (body.trim() ? (marked.parse(body, { async: false }) as string) : '<p class="empty">빈 노트</p>')
}

type Target = { vault: string; path: string }
let target: Target | null = null
let text = ''
let editing = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined

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
  mode.hidden = !target
  page.hidden = editing || !isPage(target)
  view.hidden = editing || isPage(target)
  if (!target) view.innerHTML = '<p class="empty">Baalda 패널에서 노트를 선택하세요</p>'
  else if (editing) return
  else if (isPage(target)) page.srcdoc = withSdk(text) // HTML page (dashboard): sandboxed, own origin
  else view.innerHTML = render(text)
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

// Follow note links inside the vault; open web links in the browser.
view.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()
  if (a.hasAttribute('data-external')) {
    void orca.shell?.openExternal(a.getAttribute('href') ?? '')
    return
  }
  if (a.dataset.target) goto(a.dataset.target)
})

async function save(): Promise<void> {
  clearTimeout(timer)
  if (!target || !dirty) return
  dirty = false
  state.textContent = '저장 중…'
  try {
    await orca.plugin.request('note.write', { ...target, text })
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
  const body = next ? (await orca.plugin.request('note.read', next)).text : ''
  if (mine !== loads) return // a later click won while this read was in flight
  target = next
  text = body
  state.textContent = ''
  if (editing) source.value = text
  show()
}

mode.addEventListener('click', () => {
  editing = !editing
  mode.textContent = editing ? '보기' : '편집'
  source.hidden = !editing
  if (editing) {
    source.value = text
    source.focus()
  }
  if (!editing) void save()
  show()
})
source.addEventListener('input', () => {
  text = source.value
  dirty = true
  state.textContent = '수정됨'
  clearTimeout(timer)
  timer = setTimeout(() => void save(), 800) // autosave: the tab's own file is only the pointer
})
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void save()
  }
})

// The note changed on disk (Baalda sync, another editor): reload unless the user is typing.
orca.plugin.on('notes.changed', () => {
  if (target && !dirty && !editing) void load(target)
})

const doc = await orca.document!.session<string>()
doc.onReplace((raw) => void load(parse(raw)))
await load(parse(doc.value))
