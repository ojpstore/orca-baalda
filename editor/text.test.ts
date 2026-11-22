import { assert, test } from 'orca/testing'
import { continueList, indentLines, pickNotes, wikiQuery } from './text'

const run = (v: string, e: { from: number; to: number; text: string } | null) => (e ? v.slice(0, e.from) + e.text + v.slice(e.to) : v)

test('Enter continues bullets, numbers and tasks; an empty item ends the list', () => {
  assert.equal(run('- a', continueList('- a', 3)), '- a\n- ')
  assert.equal(run('  * a', continueList('  * a', 5)), '  * a\n  * ')
  assert.equal(run('2. x', continueList('2. x', 4)), '2. x\n3. ')
  assert.equal(run('- [x] done', continueList('- [x] done', 10)), '- [x] done\n- [ ] ')
  assert.equal(run('- a\n- ', continueList('- a\n- ', 6)), '- a\n')
  assert.equal(run('- [ ] ', continueList('- [ ] ', 6)), '')
  assert.equal(run('- ab', continueList('- ab', 3)), '- a\n- b') // splits the item
})

test('Enter is left alone outside lists, in the marker and in code blocks', () => {
  assert.equal(continueList('plain', 5), null)
  assert.equal(continueList('**bold**', 8), null)
  assert.equal(continueList('- a', 1), null)
  assert.equal(continueList('```\n- a', 7), null)
})

test('Tab indents and Shift+Tab outdents the touched lines', () => {
  assert.equal(run('abc', indentLines('abc', 3, 3, false)), 'abc    ') // plain text: just spaces
  assert.equal(run('- a', indentLines('- a', 3, 3, false)), '    - a')
  assert.deepEqual(indentLines('- a', 3, 3, false).sel, [7, 7])
  const two = '- a\n\n- b'
  assert.equal(run(two, indentLines(two, 0, two.length, false)), '    - a\n\n    - b')
  assert.equal(run('    - a', indentLines('    - a', 5, 5, true)), '- a')
  assert.equal(run('  - a', indentLines('  - a', 3, 3, true)), '- a')
})

test('[[ autocomplete finds the query and ranks names first', () => {
  assert.deepEqual(wikiQuery('see [[Con', 9), { start: 4, q: 'Con' })
  assert.equal(wikiQuery('see [[a]] x', 11), null)
  assert.equal(wikiQuery('[[a|b', 5), null)
  const keys = ['Concepts/A.md', 'Docs/Concept.md', 'Concepts/Zed.md', 'Home.html']
  assert.deepEqual(pickNotes(keys, 'conc'), ['Docs/Concept.md', 'Concepts/A.md', 'Concepts/Zed.md'])
  assert.deepEqual(pickNotes(keys, 'home'), ['Home.html'])
  assert.deepEqual(pickNotes(keys, ''), keys.slice().sort((a, b) => a.length - b.length || a.localeCompare(b)))
})
