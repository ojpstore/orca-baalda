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
  await worker.request('note.write', { vault, path: 'Welcome.md', text: 'edited' })
  assert.equal(readFileSync(join(vault, 'Welcome.md'), 'utf8'), 'edited')

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
test('deletes notes only, to the Recycle Bin on Windows', async () => {
  const { vault } = fixture()
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('note.delete', { vault, path: 'Concepts/A.md' })
  assert.equal(existsSync(join(vault, 'Concepts', 'A.md')), false)
  await assert.rejects(worker.request('note.delete', { vault, path: 'Concepts/' }))
  await assert.rejects(worker.request('note.delete', { vault, path: '../config.json' }))
  await worker.deactivate()
})
