// Reads and writes the Baalda vault's Markdown files. Baalda is local-first: its desktop app
// watches the vault folder and syncs every file change to the server, so writing here is syncing.
import type { OrcaWorkerApi } from 'orca/worker'
import type { NoteNode, Sync, Tree, Vault } from './protocol'
import { execFile, spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

// Orca starts workers with a trimmed environment: derive the Windows dirs from the home folder.
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
/** Overridable by tests. */
export const paths = {
  config: join(appData, 'com.baalda.context', 'config.json'),
  app: join(localAppData, 'Baalda', 'desktop.exe'),
  orca: join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
}
/** The one file the Baalda tab shows, inside the active workspace: `{ vault, path }` of the note. */
// Under .orca/: Orca's own folder, which its dev-plugin watcher also skips.
const VIEW_DIR = join('.orca', 'baalda')
const VIEW_FILE = 'Baalda.baalda'

/** Orca's focused workspace. Orca opens a tab only for a file inside the workspace that holds it. */
async function activeWorkspace(orca: OrcaWorkerApi): Promise<string> {
  const ctx = await orca.host.call('workspace.readContext', {})
  const id = ctx?.workspaceId
  if (!id) throw new Error('활성 워크스페이스가 없습니다. Orca에서 워크스페이스를 먼저 여세요.')
  const ws = (await orca.host.call('workspace.list', {})).workspaces.find((w) => w.id === id)
  if (!ws) throw new Error(`워크스페이스를 찾을 수 없습니다: ${id}`)
  if (ws.hostId && ws.hostId !== 'local') throw new Error('원격(SSH) 워크스페이스에는 Baalda 탭을 열 수 없습니다.')
  return resolve(ws.path)
}

type BaaldaConfig = { last_vault?: string; vaults_root?: string; recent_vaults?: Vault[] }
type VaultMeta = { serverVaultId?: string; docs?: Record<string, string>; pushed?: string[] }

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Vault folders the user picked in the panel by path, kept in the plugin's storage. */
let added: Vault[] = []
const isVault = (p: string) => existsSync(join(p, '.context'))

async function listVaults(): Promise<{ vaults: Vault[]; last: string | null; root: string | null }> {
  const cfg = (await readJson<BaaldaConfig>(paths.config)) ?? {}
  const seen = new Set<string>()
  const vaults: Vault[] = []
  for (const v of [...(cfg.recent_vaults ?? []), ...added]) {
    const p = resolve(v.path)
    // A folder holding vaults is not a vault itself: Baalda marks real ones with .context.
    if (seen.has(p) || !isVault(p)) continue
    seen.add(p)
    vaults.push({ name: v.name, path: p })
  }
  return {
    vaults,
    last: cfg.last_vault ? resolve(cfg.last_vault) : null,
    root: cfg.vaults_root ? resolve(cfg.vaults_root) : null
  }
}

/** The panel is sandboxed: only touch vaults Baalda knows, and only paths inside them. */
async function vaultDir(vault: string): Promise<string> {
  const v = resolve(vault)
  const { vaults, root } = await listVaults()
  const known = vaults.some((k) => k.path === v) || (root !== null && v.startsWith(root + sep))
  if (!known || !isVault(v)) throw new Error(`Not a Baalda vault: ${vault}`)
  return v
}

function inside(vault: string, rel: string): string {
  const p = resolve(vault, rel)
  if (!p.startsWith(vault + sep)) throw new Error(`Path escapes the vault: ${rel}`)
  return p
}

const BAD_NAME = /[\\/:*?"<>|]|^\.|^\s*$/
/** Documents Baalda shows and syncs: Markdown notes and HTML pages (dashboards). */
const DOC = /\.(md|html?)$/i
const isDoc = (p: string) => DOC.test(p)
const slash = (p: string) => p.replace(/\\/g, '/')

function docFile(vault: string, rel: string): string {
  const file = inside(vault, rel)
  if (!isDoc(file) || !existsSync(file)) throw new Error(`No such note: ${rel}`)
  return file
}

/**
 * Resolves a [[wikilink]] or relative link target to a vault document, as Baalda does: a vault
 * path with or without `.md`, then relative to the linking note, then the first document with
 * that name anywhere in the vault.
 */
export async function resolveLink(vault: string, from: string, target: string): Promise<string | null> {
  const t = slash(target.split('#')[0]).replace(/^\.?\//, '').trim()
  if (!t) return null
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  for (const base of ['', dir]) {
    for (const cand of [base + t, base + t + '.md']) {
      try {
        if (isDoc(cand) && existsSync(inside(vault, cand))) return slash(resolve(vault, cand).slice(vault.length + 1))
      } catch {
        // escapes the vault: try the next candidate
      }
    }
  }
  const name = (t.split('/').pop() ?? t).toLowerCase()
  const want = isDoc(name) ? [name] : [name + '.md', name + '.html']
  const files = (await readdir(vault, { recursive: true })).map((f) => slash(String(f)))
  return files.find((f) => !f.split('/').some((p) => p.startsWith('.')) && want.includes((f.split('/').pop() ?? '').toLowerCase())) ?? null
}

async function walk(dir: string, rel: string, status: (rel: string) => Sync): Promise<NoteNode[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const folders: NoteNode[] = []
  const notes: NoteNode[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const r = rel + e.name
    if (e.isDirectory()) {
      const children = await walk(join(dir, e.name), r + '/', status)
      const sync: Sync = children.some((c) => c.sync === 'pending') ? 'pending' : status('')
      folders.push({ key: r + '/', label: e.name, kind: 'folder', sync, children })
    } else if (/\.md$/i.test(e.name)) {
      notes.push({ key: r, label: e.name.slice(0, -3), kind: 'note', sync: status(r) })
    } else if (isDoc(e.name)) {
      notes.push({ key: r, label: e.name.replace(DOC, ''), kind: 'page', sync: status(r) })
    }
  }
  const byLabel = (a: NoteNode, b: NoteNode) => a.label.localeCompare(b.label)
  return [...folders.sort(byLabel), ...notes.sort(byLabel)]
}

export async function tree(vault: string): Promise<Tree> {
  const meta = (await readJson<VaultMeta>(join(vault, '.context', 'config.json'))) ?? {}
  const pushed = new Set(meta.pushed ?? [])
  const docs = meta.docs ?? {}
  const remote = Boolean(meta.serverVaultId)
  const pending: string[] = []
  let synced = 0
  const items = await walk(vault, '', (rel) => {
    if (!remote) return 'local'
    if (!rel) return 'synced' // a folder with nothing pending
    const id = docs[rel]
    if (id !== undefined && pushed.has(id)) {
      synced++
      return 'synced'
    }
    pending.push(rel)
    return 'pending'
  })
  return { items, remote, synced, pending }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile(file, args, { env: { ...process.env, USERPROFILE: homedir(), APPDATA: appData, LOCALAPPDATA: localAppData } }, (err, out, errOut) =>
      err ? fail(new Error(String(errOut || out || err.message).slice(0, 500))) : done(out)
    )
  )
}

/** This plugin's key: `local.baalda-notes` as a dev folder, `<owner>.baalda-notes` when installed. */
let pluginKey: string | null = null
async function ownKey(): Promise<string> {
  if (pluginKey) return pluginKey
  const list = JSON.parse(await run(paths.orca, ['plugin', 'list', '--json'])) as {
    result: { plugins: { pluginKey: string }[] }
  }
  pluginKey = list.result.plugins.find((p) => p.pluginKey.endsWith('.baalda-notes'))?.pluginKey ?? 'local.baalda-notes'
  return pluginKey
}

function baaldaRunning(): Promise<boolean> {
  return new Promise((done) =>
    // Absolute path: the worker's trimmed environment may have no PATH.
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', 'IMAGENAME eq desktop.exe', '/NH'], (err, out) =>
      done(!err && out.toLowerCase().includes('desktop.exe'))
    )
  )
}

let watcher: { vault: string; w: FSWatcher } | null = null

function watchVault(orca: OrcaWorkerApi, vault: string): void {
  if (watcher?.vault === vault) return
  watcher?.w.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  const w = watch(vault, { recursive: true }, (_e, file) => {
    const f = String(file ?? '')
    if (!isDoc(f) && !f.endsWith('config.json')) return // skip Baalda's sqlite churn
    clearTimeout(timer)
    timer = setTimeout(() => orca.panels.post('notes.changed', { vault }), 300)
  })
  watcher = { vault, w }
}

/** Windows' folder dialog, on top of Orca; answers the chosen folder, or '' when cancelled. */
function pickFolder(initial: string): Promise<string> {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Baalda 볼트 폴더를 선택하세요 (.context 폴더가 있는 곳)'",
    '$d.ShowNewFolderButton = $false',
    'if ($env:BAALDA_INITIAL -and (Test-Path -LiteralPath $env:BAALDA_INITIAL)) { $d.SelectedPath = $env:BAALDA_INITIAL }',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
  ].join('\n')
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((done, fail) =>
    execFile(
      ps,
      ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, BAALDA_INITIAL: initial }, encoding: 'utf8' },
      (err, out, errOut) => (err ? fail(new Error(String(errOut || err.message).slice(0, 300))) : done(out))
    )
  )
}

export default function activate(orca: OrcaWorkerApi): void {
  const loaded = orca.storage
    .get('addedVaults')
    .then((v) => (added = Array.isArray(v) ? (v as Vault[]) : []))
    .catch(() => {})

  orca.panels.handle('vaults.list', async () => {
    await loaded
    const { vaults, last } = await listVaults()
    return { vaults, last }
  })

  // "경로 변경": use any folder Baalda has made a vault (it has .context), even one not in its list.
  async function addVault(path: string): Promise<Vault> {
    await loaded
    const p = resolve(path.trim().replace(/^"|"$/g, ''))
    if (!isVault(p)) throw new Error(`Baalda 볼트가 아닙니다(.context 폴더 없음): ${p}`)
    const vault = { name: basename(p), path: p }
    if (!added.some((v) => v.path === p)) {
      added = [...added, vault]
      await orca.storage.set('addedVaults', added)
    }
    return vault
  }

  orca.panels.handle('vault.add', ({ path }) => addVault(path))

  // A sandboxed panel cannot show a folder dialog: the worker shows Windows' own.
  orca.panels.handle('vault.pick', async ({ initial }) => {
    if (process.platform !== 'win32') throw new Error('폴더 선택 창은 Windows에서만 지원합니다.')
    const picked = (await pickFolder(initial)).trim()
    return picked ? { vault: await addVault(picked) } : { vault: null }
  })

  orca.panels.handle('notes.tree', async ({ vault }) => {
    const v = await vaultDir(vault)
    watchVault(orca, v)
    return tree(v)
  })

  orca.panels.handle('note.read', async ({ vault, path }) => {
    const v = await vaultDir(vault)
    return { text: await readFile(docFile(v, path), 'utf8') }
  })

  // Shows a note in the single Baalda tab of the active workspace: point that workspace's view
  // file at the note, then open it (Orca reuses the tab when it is already open; the editor
  // reloads on the file change). Panels hear which note is showing.
  async function show(v: string, path: string): Promise<void> {
    docFile(v, path)
    const dir = join(await activeWorkspace(orca), VIEW_DIR)
    await mkdir(dir, { recursive: true })
    // Self-ignoring folder: keeps the view file out of the workspace's git status.
    if (!existsSync(join(dir, '.gitignore'))) await writeFile(join(dir, '.gitignore'), '*\n', 'utf8')
    const view = join(dir, VIEW_FILE)
    await writeFile(view, JSON.stringify({ vault: v, path }), 'utf8')
    await run(paths.orca, ['plugin', 'open', await ownKey(), '--editor', view, '--json'])
    orca.panels.post('note.shown', { vault: v, path })
  }

  orca.panels.handle('note.open', async ({ vault, path }) => {
    await show(await vaultDir(vault), path)
    return { ok: true as const }
  })

  orca.panels.handle('note.goto', async ({ vault, from, target }) => {
    const v = await vaultDir(vault)
    const path = await resolveLink(v, from, target)
    if (!path) throw new Error(`노트를 찾을 수 없습니다: ${target}`)
    await show(v, path)
    return { path }
  })

  orca.panels.handle('note.write', async ({ vault, path, text }) => {
    const v = await vaultDir(vault)
    const file = docFile(v, path)
    await writeFile(file, text, 'utf8')
    return { ok: true as const }
  })

  orca.panels.handle('note.create', async ({ vault, folder, name, kind }) => {
    const v = await vaultDir(vault)
    const clean = name.trim().replace(/\.md$/i, '')
    if (BAD_NAME.test(clean)) throw new Error(`Invalid name: ${name}`)
    const rel = (folder ? folder.replace(/\/?$/, '/') : '') + (kind === 'note' ? clean + '.md' : clean)
    const target = inside(v, rel)
    if (existsSync(target)) throw new Error(`Already exists: ${rel}`)
    if (kind === 'folder') await mkdir(target)
    else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    }
    return { path: kind === 'folder' ? rel + '/' : rel }
  })

  orca.panels.handle('sync.run', async ({ vault }) => {
    await vaultDir(vault)
    if (process.platform !== 'win32') return { started: false, running: false }
    if (await baaldaRunning()) return { started: false, running: true }
    if (!existsSync(paths.app)) throw new Error(`Baalda app not found: ${paths.app}`)
    spawn(paths.app, [], { detached: true, stdio: 'ignore' }).unref()
    return { started: true, running: true }
  })
}

export function deactivate(): void {
  watcher?.w.close()
  watcher = null
}
