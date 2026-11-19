// Runs the worker over a throwaway vault on disk, with Baalda's config pointed at it.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as main from './worker'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'baalda-'))
  const vault = join(root, 'v')
  mkdirSync(join(vault, '.context'), { recursive: true })
  mkdirSync(join(vault, 'Concepts'))
  writeFileSync(join(vault, 'Welcome.md'), '# Hi')
  writeFileSync(join(vault, 'Concepts', 'A.md'), 'a')
  mkdirSync(join(vault, 'Dashboards'))
  writeFileSync(join(vault, 'Dashboards', 'Home.html'), '<p>dash</p>')
  writeFileSync(join(vault, 'Dashboards', 'data.json'), '{}')
  writeFileSync(
    join(vault, '.context', 'config.json'),
    JSON.stringify({ serverVaultId: 's', docs: { 'Welcome.md': 'w', 'Concepts/A.md': 'a', 'Dashboards/Home.html': 'h' }, pushed: ['w', 'h'] })
  )
  const config = join(root, 'config.json')
  writeFileSync(config, JSON.stringify({ last_vault: vault, recent_vaults: [{ name: 'v', path: vault }, { name: 'root', path: root }] }))
  main.paths.config = config
  return { root, vault }
}

test('lists vaults, builds the tree with sync status, reads, writes and creates notes', async () => {
  const { root, vault } = fixture()
  const worker = await mountWorker(main, { host: mockHost() })

  const { vaults } = await worker.request('vaults.list')
  assert.deepEqual(vaults.map((v) => v.name), ['v']) // root has no .context: not a vault

  const t = await worker.request('notes.tree', { vault })
  assert.deepEqual(t.items.map((i) => i.key), ['Concepts/', 'Dashboards/', 'Welcome.md'])
  // HTML pages are Baalda documents too; other files are not shown.
  assert.deepEqual(t.items[1].children, [{ key: 'Dashboards/Home.html', label: 'Home', kind: 'page', sync: 'synced' }])
  assert.deepEqual(t.pending, ['Concepts/A.md']) // known but not pushed
  assert.equal(t.synced, 2)
  assert.deepEqual(t.items.map((i) => i.sync), ['pending', 'synced', 'synced']) // a folder is pending if any note in it is

  assert.equal((await worker.request('note.read', { vault, path: 'Welcome.md' })).text, '# Hi')
  // Locking a vault reaches the tree and the editor's read; unlocking clears it.
  assert.equal(t.locked, false)
  await worker.request('vault.lock', { vault, locked: true })
  assert.equal((await worker.request('notes.tree', { vault })).locked, true)
  assert.equal((await worker.request('note.read', { vault, path: 'Welcome.md' })).locked, true)
  await worker.request('vault.lock', { vault, locked: false })
  assert.equal((await worker.request('note.read', { vault, path: 'Welcome.md' })).locked, false)
  await worker.request('note.write', { vault, path: 'Welcome.md', text: 'edited' })
  assert.equal(readFileSync(join(vault, 'Welcome.md'), 'utf8'), 'edited')
  // A long note arrives in parts and lands only with the last one.
  await worker.request('note.write', { vault, path: 'Welcome.md', text: '가나', more: true })
  assert.equal(readFileSync(join(vault, 'Welcome.md'), 'utf8'), 'edited')
  await worker.request('note.write', { vault, path: 'Welcome.md', text: '다', offset: 2 })
  assert.equal(readFileSync(join(vault, 'Welcome.md'), 'utf8'), '가나다')
  await assert.rejects(worker.request('note.write', { vault, path: 'Welcome.md', text: 'x', offset: 5 }))

  const made = await worker.request('note.create', { vault, folder: 'Concepts/', name: 'B', kind: 'note' })
  assert.equal(made.path, 'Concepts/B.md')
  const dir = await worker.request('note.create', { vault, folder: '', name: 'New', kind: 'folder' })
  assert.equal(dir.path, 'New/')

  await assert.rejects(worker.request('note.read', { vault, path: '../config.json' }))
  await assert.rejects(worker.request('notes.tree', { vault: root }))
  await assert.rejects(worker.request('note.create', { vault, folder: '', name: '../x', kind: 'note' }))
  await assert.rejects(worker.request('note.create', { vault, folder: 'Concepts/', name: 'B', kind: 'note' }))
  await worker.deactivate()
})

test('resolves wikilinks like Baalda: vault path, relative, then by name', async () => {
  const { vault } = fixture()
  const r = (from: string, target: string) => main.resolveLink(vault, from, target)
  assert.equal(await r('Welcome.md', 'Concepts/A'), 'Concepts/A.md')
  assert.equal(await r('Welcome.md', 'Dashboards/Home.html'), 'Dashboards/Home.html')
  assert.equal(await r('Concepts/A.md', 'A#Heading'), 'Concepts/A.md') // relative, anchor dropped
  assert.equal(await r('Welcome.md', 'home'), 'Dashboards/Home.html') // by name, any folder
  assert.equal(await r('Welcome.md', 'Missing'), null)
  assert.equal(await r('Welcome.md', '../../etc/passwd'), null)
})

// Its own worker: a delete under notes.tree's vault watcher keeps the test host from exiting.
test('deletes notes and folders, to the Recycle Bin on Windows', async () => {
  const { vault } = fixture()
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('note.delete', { vault, path: 'Concepts/A.md' })
  assert.equal(existsSync(join(vault, 'Concepts', 'A.md')), false)
  await worker.request('note.delete', { vault, path: 'Concepts/' })
  assert.equal(existsSync(join(vault, 'Concepts')), false)
  await assert.rejects(worker.request('note.delete', { vault, path: '.context/' }))
  await assert.rejects(worker.request('note.delete', { vault, path: '../config.json' }))
  await worker.deactivate()
})

test('renames and moves notes and folders safely within the vault', async () => {
  const { vault } = fixture()
  const worker = await mountWorker(main, { host: mockHost() })

  const rNote = await worker.request('note.rename', { vault, path: 'Concepts/A.md', name: 'Alpha' })
  assert.equal(rNote.path, 'Concepts/Alpha.md')
  assert.equal(existsSync(join(vault, 'Concepts', 'Alpha.md')), true)

  const rPage = await worker.request('note.rename', { vault, path: 'Dashboards/Home.html', name: 'Main' })
  assert.equal(rPage.path, 'Dashboards/Main.html')
  assert.equal(existsSync(join(vault, 'Dashboards', 'Main.html')), true)

  const rDir = await worker.request('note.rename', { vault, path: 'Concepts/', name: 'Ideas' })
  assert.equal(rDir.path, 'Ideas/')
  assert.equal(existsSync(join(vault, 'Ideas', 'Alpha.md')), true)

  const mNote = await worker.request('note.move', { vault, from: 'Ideas/Alpha.md', toFolder: '' })
  assert.equal(mNote.path, 'Alpha.md')
  assert.equal(existsSync(join(vault, 'Alpha.md')), true)

  const mDir = await worker.request('note.move', { vault, from: 'Ideas/', toFolder: 'Dashboards/' })
  assert.equal(mDir.path, 'Dashboards/Ideas/')
  assert.equal(existsSync(join(vault, 'Dashboards', 'Ideas')), true)

  await assert.rejects(worker.request('note.move', { vault, from: 'Dashboards/', toFolder: 'Dashboards/Ideas/' }))
  await assert.rejects(worker.request('note.rename', { vault, path: 'Alpha.md', name: '../escape' }))
  await assert.rejects(worker.request('note.rename', { vault, path: '.context/', name: 'x' }))
  await worker.deactivate()
})

test('searches note text, case-insensitive, skipping dot folders', async () => {
  const { vault } = fixture()
  writeFileSync(join(vault, '.context', 'x.md'), 'dash')
  assert.deepEqual(await main.search(vault, 'dash'), ['Dashboards/Home.html'])
  assert.deepEqual(await main.search(vault, 'hi'), ['Welcome.md'])
  assert.deepEqual(await main.search(vault, '없는말'), [])
})

test('sync points Baalda at the chosen vault, keeping the rest of its config', async () => {
  const { root, vault } = fixture()
  await main.openOnStart(root)
  const cfg = JSON.parse(readFileSync(main.paths.config, 'utf8'))
  assert.equal(cfg.last_vault, root)
  assert.equal(cfg.recent_vaults.length, 2)
  await main.openOnStart(vault)
  assert.equal(JSON.parse(readFileSync(main.paths.config, 'utf8')).last_vault, vault)
})

test('finds the server of a vault from Baalda webview storage', async () => {
  const { root, vault } = fixture()
  const cfg = join(vault, '.context', 'config.json')
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), organizationId: 'org1' }))
  // One write-ahead log record holding one localStorage put, as Chromium writes it.
  const key = Buffer.from('_http://tauri.localhost\x00\x01context.knownVaults:https://my.server', 'latin1')
  const value = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify([{ id: 'org1', name: 'v' }]))])
  const batch = Buffer.concat([Buffer.alloc(8, 0), Buffer.from([1, 0, 0, 0, 1, key.length]), key, Buffer.from([value.length]), value])
  const head = Buffer.alloc(7)
  head.writeUInt16LE(batch.length, 4)
  head[6] = 1
  mkdirSync(join(root, 'ls'))
  writeFileSync(join(root, 'ls', '000003.log'), Buffer.concat([head, batch]))
  main.paths.webStorage = join(root, 'ls')
  assert.equal(await main.vaultServer(vault), 'https://my.server')
  assert.equal(await main.openOnStart(vault), 'https://my.server')
  assert.equal(JSON.parse(readFileSync(main.paths.config, 'utf8')).server_url, 'https://my.server')
})

test('a sync run stops when Baalda is not on the chosen vault', () => {
  const v = join('C:', 'v', 'mynote')
  const line = (s: string) => `[t][x][INFO] ${s}
`
  const opened = line(`[open_vault] ${v} — index_open 1ms`)
  const s = 'https://my.server'
  assert.equal(main.wrongVault(opened, v, s), null)
  assert.match(main.wrongVault(opened + line(`[open_vault] ${join('C:', 'v')} — x`), v, s) ?? '', /대신 "v"/)
  assert.match(main.wrongVault('', v, s) ?? '', /열지 못했습니다/)
})
