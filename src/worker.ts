// Reads and writes the Baalda vault's Markdown files. Baalda is local-first: its desktop app
// watches the vault folder and syncs every file change to the server, so writing here is syncing.
import type { OrcaWorkerApi } from 'orca/worker'
import type { NoteNode, Sync, SyncState, Tree, Vault } from './protocol'
import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

// Orca starts workers with a trimmed environment: derive the Windows dirs from the home folder.
const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
/** Overridable by tests. */
export const paths = {
  config: join(appData, 'com.baalda.context', 'config.json'),
  app: join(localAppData, 'Baalda', 'desktop.exe'),
  orca: join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
  log: join(localAppData, 'com.baalda.context', 'logs', 'baalda.log')
}
/** Auto-close timing for a sync run: at least minMs, state quiet for quietMs, give up after maxMs. */
const SYNC = { minMs: 15_000, quietMs: 8_000, maxMs: 300_000 }
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

type BaaldaConfig = { server_url?: string; last_vault?: string; vaults_root?: string; recent_vaults?: Vault[] }
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

/** Vault documents whose text contains `q` (already normalized), in readdir order. */
// ponytail: reads every document per query; add an index if vaults grow past a few thousand notes.
export async function search(vault: string, q: string, limit = 500): Promise<string[]> {
  const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase()
  const files = (await readdir(vault, { recursive: true }))
    .map((f) => slash(String(f)))
    .filter((f) => isDoc(f) && !f.split('/').some((p) => p.startsWith('.')))
  const hits: string[] = []
  for (const f of files) {
    if (hits.length >= limit) break
    const text = await readFile(join(vault, f), 'utf8').catch(() => '')
    if (norm(text).includes(q)) hits.push(f)
  }
  return hits
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

function powershell(script: string, env: Record<string, string>, sta = false): Promise<string> {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const body = '[Console]::OutputEncoding = [Text.Encoding]::UTF8\n' + script
  const args = ['-NoProfile', '-NonInteractive', ...(sta ? ['-STA'] : []), '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')]
  return new Promise((done, fail) =>
    execFile(ps, args, { env: { ...process.env, ...env }, encoding: 'utf8' }, (err, out, errOut) =>
      err ? fail(new Error(String(errOut || err.message).slice(0, 300))) : done(out)
    )
  )
}

/** Windows' folder dialog, on top of Orca; answers the chosen folder, or '' when cancelled. */
function pickFolder(initial: string): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Baalda 볼트 폴더를 선택하세요 (.context 폴더가 있는 곳)'",
    '$d.ShowNewFolderButton = $false',
    'if ($env:BAALDA_INITIAL -and (Test-Path -LiteralPath $env:BAALDA_INITIAL)) { $d.SelectedPath = $env:BAALDA_INITIAL }',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
  ].join('\n')
  return powershell(script, { BAALDA_INITIAL: initial }, true)
}

// Window helpers for the Baalda desktop app (the sync engine). A sync run starts Baalda on its own
// Windows desktop (DESK, in the same session): nothing it shows can reach the person's screen.
const DESK = 'BaaldaOrcaSync'
const WIN32 = [
  "Add-Type @'",
  'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;',
  'public static class BW {',
  '  delegate bool P(IntPtr h, IntPtr l);',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {',
  '    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;',
  '    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;',
  '    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }',
  '  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);',
  '  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr d, P p, IntPtr l);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktop(string n, IntPtr dev, IntPtr mode, int f, uint a, IntPtr sa);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktop(string n, int f, bool inherit, uint a);',
  '  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);',
  '  [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr d);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint f, IntPtr env, string dir, ref SI si, out PI pi);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
  '  const uint ALL = 0x10000000;',
  '  static bool Titled(IntPtr h, string title) { var b = new StringBuilder(256); GetWindowText(h, b, 256); return b.ToString() == title; }',
  '  /** Starts exe on the named desktop (created if needed); answers its pid, or 0. */',
  '  public static int Start(string exe, string desk) {',
  '    var d = CreateDesktop(desk, IntPtr.Zero, IntPtr.Zero, 0, ALL, IntPtr.Zero);',
  '    if (d == IntPtr.Zero) return 0;',
  '    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.lpDesktop = "WinSta0\\\\" + desk;',
  '    PI pi;',
  '    if (!CreateProcess(exe, null, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, System.IO.Path.GetDirectoryName(exe), ref si, out pi)) return 0;',
  '    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);',
  '    System.Threading.Thread.Sleep(5000); // keep the desktop open until the app has attached to it',
  '    CloseDesktop(d);',
  '    return pi.dwProcessId;',
  '  }',
  '  /** Windows titled `title` on the named desktop (none when it does not exist). */',
  '  public static List<IntPtr> OnDesk(string desk, string title) {',
  '    var r = new List<IntPtr>(); var d = OpenDesktop(desk, 0, false, ALL);',
  '    if (d == IntPtr.Zero) return r;',
  '    EnumDesktopWindows(d, (h, l) => { if (Titled(h, title)) r.Add(h); return true; }, IntPtr.Zero);',
  '    CloseDesktop(d); return r;',
  '  }',
  '  /** Posts WM_CLOSE to the windows titled `title` on the named desktop. Messages do not cross',
  '   *  desktops, so a fresh thread (no windows of its own) joins that desktop to post them. */',
  '  public static int CloseOn(string desk, string title) {',
  '    int n = 0;',
  '    var t = new System.Threading.Thread(() => {',
  '      var d = OpenDesktop(desk, 0, false, ALL);',
  '      if (d == IntPtr.Zero || !SetThreadDesktop(d)) return;',
  '      EnumDesktopWindows(d, (h, l) => { if (Titled(h, title) && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) n++; return true; }, IntPtr.Zero);',
  '    });',
  '    t.Start(); t.Join();',
  '    return n;',
  '  }',
  '  /** Windows titled `title` of process `pid` on the person\'s desktop. */',
  '  public static List<IntPtr> Of(uint pid, string title) {',
  '    var r = new List<IntPtr>();',
  '    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && Titled(h, title)) r.Add(h); return true; }, IntPtr.Zero);',
  '    return r;',
  '  }',
  '}',
  "'@",
  'function Baalda { Get-Process desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:BAALDA_EXE } }'
].join('\n')

/** Whether the Baalda desktop app (this exact exe) runs. */
async function baaldaRunning(): Promise<boolean> {
  const script = 'if (Get-Process desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:BAALDA_EXE }) { "yes" }'
  return (await powershell(script, { BAALDA_EXE: paths.app })).includes('yes')
}

/**
 * Starts Baalda on the hidden desktop. Baalda has no hidden-start option and shows its own window,
 * but a window on another desktop never reaches the person's screen. Answers the pid, or throws.
 */
async function startHidden(): Promise<number> {
  const script = [WIN32, '[Console]::Out.Write([BW]::Start($env:BAALDA_EXE, $env:BAALDA_DESK))'].join('\n')
  const pid = Number(await powershell(script, { BAALDA_EXE: paths.app, BAALDA_DESK: DESK }))
  if (!pid) throw new Error('Baalda를 숨김 데스크톱에서 실행하지 못했습니다.')
  return pid
}

/**
 * Closes the Baalda the sync run started, the way its X button does (WM_CLOSE to its "Baalda"
 * window), and waits for that window to go. Its sync engine lives in that window's webview, so
 * once it is gone nothing is syncing; but the process stays behind with no window, and Baalda
 * being single-instance, the person could then not open it again. So a process still left a few
 * seconds later is ended. Answers 'closed', or 'running' when the window never closed.
 */
function closeApp(): Promise<string> {
  const script = [
    WIN32,
    "function Mains { [BW]::OnDesk($env:BAALDA_DESK, 'Baalda') }",
    "[void][BW]::CloseOn($env:BAALDA_DESK, 'Baalda')",
    '$end = (Get-Date).AddSeconds(15)',
    'while (@(Mains).Count -gt 0 -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 300 }',
    "if (@(Mains).Count -gt 0) { [Console]::Out.Write('running'); exit }",
    '$end = (Get-Date).AddSeconds(3)',
    'while ((Baalda) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 300 }',
    'Baalda | Stop-Process -ErrorAction SilentlyContinue',
    'Start-Sleep -Milliseconds 500',
    "if (Baalda) { [Console]::Out.Write('running') } else { [Console]::Out.Write('closed') }"
  ].join('\n')
  return powershell(script, { BAALDA_EXE: paths.app, BAALDA_DESK: DESK })
}

/**
 * Shows Baalda to the person. One on the hidden desktop cannot be moved over, and one with no
 * window cannot be shown: both are ended and Baalda starts normally. One already on their desktop
 * is brought forward.
 */
function showApp(): Promise<string> {
  const script = [
    WIN32,
    '$shown = $false',
    'if (@([BW]::OnDesk($env:BAALDA_DESK, \'Baalda\')).Count -eq 0) {',
    '  foreach ($p in @(Baalda)) {',
    "    foreach ($h in [BW]::Of([uint32]$p.Id, 'Baalda')) { [void][BW]::ShowWindow($h, 5); [void][BW]::SetForegroundWindow($h); $shown = $true }",
    '  }',
    '}',
    'if (-not $shown) {',
    '  Baalda | Stop-Process -ErrorAction SilentlyContinue',
    '  $end = (Get-Date).AddSeconds(5)',
    '  while ((Baalda) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }',
    '  Start-Process -FilePath $env:BAALDA_EXE',
    '}',
    "[Console]::Out.Write('ok')"
  ].join('\n')
  return powershell(script, { BAALDA_EXE: paths.app, BAALDA_DESK: DESK })
}

export default function activate(orca: OrcaWorkerApi): void {
  const loaded = orca.storage
    .get('addedVaults')
    .then((v) => (added = Array.isArray(v) ? (v as Vault[]) : []))
    .catch(() => {})
  // Vaults locked in the panel, by resolved path: their notes open read-only.
  const locks = orca.storage
    .get('lockedVaults')
    .then((v) => new Set(Array.isArray(v) ? (v as string[]) : []))
    .catch(() => new Set<string>())

  orca.panels.handle('vault.lock', async ({ vault, locked }) => {
    const v = await vaultDir(vault)
    const set = await locks
    if (locked) set.add(v)
    else set.delete(v)
    await orca.storage.set('lockedVaults', [...set])
    orca.panels.post('vault.locked', { vault: v, locked })
    return { ok: true as const }
  })

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
    return { ...(await tree(v)), locked: (await locks).has(v) }
  })

  orca.panels.handle('notes.search', async ({ vault, q }) => ({ keys: q ? await search(await vaultDir(vault), q) : [] }))

  orca.panels.handle('note.read', async ({ vault, path }) => {
    const v = await vaultDir(vault)
    return { text: await readFile(docFile(v, path), 'utf8'), locked: (await locks).has(v) }
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

  // Parts of a long note not written yet, by file.
  const parts = new Map<string, string>()
  orca.panels.handle('note.write', async ({ vault, path, text, offset = 0, more = false }) => {
    const v = await vaultDir(vault)
    const file = docFile(v, path)
    const before = offset ? parts.get(file) : ''
    parts.delete(file)
    if (before?.length !== offset) throw new Error('Note write parts arrived out of order; save again')
    if (more) parts.set(file, before + text)
    else await writeFile(file, before + text, 'utf8')
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

  // Recycle Bin, not unlink: Baalda syncs the deletion to the server, so keep a way back.
  orca.panels.handle('note.delete', async ({ vault, path }) => {
    const file = docFile(await vaultDir(vault), path)
    if (process.platform !== 'win32') await rm(file)
    else
      await powershell(
        "Add-Type -AssemblyName Microsoft.VisualBasic\n[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:BAALDA_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        { BAALDA_FILE: file }
      )
    return { ok: true as const }
  })

  /** Bumped by "앱 창 열기": the person took the app over, so a pending auto-close is dropped. */
  let syncRun = 0
  let server = ''
  /** Vault of the run still waiting to close Baalda, so "앱 창 열기" can end it for the panel. */
  let syncing: string | null = null
  const status = (vault: string, state: SyncState, message: string) => {
    syncing = state === 'syncing' ? vault : null
    orca.panels.post('sync.status', { vault, state, message, server })
  }

  /**
   * Baalda pushes on its own once running; nothing says "done". Treat it as done when it has
   * connected (`channel-ready` in its log since we started it), the vault has nothing pending,
   * and its sync state file has been quiet for a while. Then close it like its X button would.
   */
  async function closeWhenSynced(vault: string, run: number, logStart: number): Promise<void> {
    const started = Date.now()
    const stateFile = join(vault, '.context', 'config.json')
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      if (run !== syncRun) return
      const elapsed = Date.now() - started
      if (elapsed > SYNC.maxMs) {
        orca.log('sync: gave up waiting; leaving Baalda running')
        status(vault, 'timeout', '동기화 완료를 확인하지 못했습니다. Baalda 앱 창 열기로 확인하세요.')
        return
      }
      if (elapsed < SYNC.minMs) continue
      const log = await readFile(paths.log, 'utf8').catch(() => '')
      if (!log.slice(logStart).includes('channel-ready')) continue
      const quietMs = Date.now() - ((await stat(stateFile).catch(() => null))?.mtimeMs ?? 0)
      if (quietMs < SYNC.quietMs) continue
      const pending = (await tree(vault)).pending.length
      if (pending > 0) {
        status(vault, 'syncing', `업로드 대기 ${pending}개`)
        continue
      }
      orca.log(`sync: done after ${Math.round(elapsed / 1000)}s, closing Baalda`)
      const closed = (await closeApp()).includes('closed')
      orca.log(`sync: Baalda ${closed ? 'closed' : 'did not close'}`)
      status(vault, closed ? 'done' : 'timeout', closed ? '동기화 완료, Baalda를 닫았습니다.' : 'Baalda가 닫히지 않아 켜 둔 채로 둡니다.')
      return
    }
  }

  // Sync = run Baalda's own engine with no window until local changes are uploaded, then close it.
  orca.panels.handle('sync.run', async ({ vault }) => {
    const v = await vaultDir(vault)
    if (process.platform !== 'win32') return { started: false, running: false }
    // A Baalda the person runs themselves syncs live already; never close theirs.
    if (await baaldaRunning()) return { started: false, running: true }
    if (!existsSync(paths.app)) throw new Error(`Baalda 앱을 찾을 수 없습니다: ${paths.app}`)
    const run = ++syncRun
    server = (await readJson<BaaldaConfig>(paths.config))?.server_url ?? '서버'
    const logStart = (await stat(paths.log).catch(() => null))?.size ?? 0
    status(v, 'syncing', '동기화 중…')
    orca.log(`sync: starting Baalda hidden for ${v}`)
    const pid = await startHidden()
    orca.log(`sync: Baalda pid ${pid} on the hidden desktop`)
    void closeWhenSynced(v, run, logStart).catch((e: unknown) =>
      status(v, 'timeout', `동기화 확인 실패: ${e instanceof Error ? e.message : String(e)}`)
    )
    return { started: true, running: true }
  })

  orca.panels.handle('app.show', async () => {
    if (process.platform !== 'win32') throw new Error('Windows에서만 지원합니다.')
    if (!existsSync(paths.app)) throw new Error(`Baalda 앱을 찾을 수 없습니다: ${paths.app}`)
    syncRun++ // keep the app the person asked to see
    if (syncing) status(syncing, 'done', 'Baalda 앱 창을 열어 자동 종료를 취소했습니다.')
    await showApp()
    return { ok: true as const }
  })
}

export function deactivate(): void {
  watcher?.w.close()
  watcher = null
}
