import { assert, test } from 'orca/testing'
import type { NoteNode } from '../src/protocol'
import { narrow, norm } from './filter'

const note = (key: string): NoteNode => ({ key, label: key.split('/').pop()!.replace(/\.md$/, ''), kind: 'note', sync: 'local' })
const folder = (key: string, children: NoteNode[]): NoteNode => ({ key, label: key.slice(0, -1).split('/').pop()!, kind: 'folder', sync: 'local', children })

const tree = folder('SOM/', [folder('SOM/위키/', [note('SOM/위키/공통 JS 로딩.md'), note('SOM/위키/근거.md')]), note('SOM/Readme.md')])

test('keeps matching notes with their folders, case-insensitive', () => {
  const hit = narrow(tree, norm('js'))
  assert.deepEqual(hit?.children?.map((c) => c.key), ['SOM/위키/'])
  assert.deepEqual(hit?.children?.[0].children?.map((c) => c.key), ['SOM/위키/공통 JS 로딩.md'])
})

test('a matching folder keeps everything inside it', () => {
  assert.equal(narrow(tree, norm('위키'))?.children?.[0].children?.length, 2)
})

test('nothing matches: null', () => {
  assert.equal(narrow(tree, norm('없는말')), null)
})
