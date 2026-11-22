// Pure text edits for the editor's textarea (no DOM), so they can be tested on their own.
/** Replace [from, to) with `text`; `sel` places the selection afterwards (default: after `text`). */
export type Edit = { from: number; to: number; text: string; sel?: [number, number] }

export const INDENT = '    '
const ITEM = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\](?:\s+|$))?(.*)$/

/** Enter in a list item: the next item's marker (a task starts unchecked), or null to leave Enter alone.
 *  On an empty item, the item is cleared instead: the list ends. */
export function continueList(value: string, pos: number): Edit | null {
  const start = value.lastIndexOf('\n', pos - 1) + 1
  const stop = value.indexOf('\n', pos)
  const end = stop < 0 ? value.length : stop
  if ((value.slice(0, start).match(/^\s*(```|~~~)/gm) ?? []).length % 2) return null // inside a code block
  const m = ITEM.exec(value.slice(start, end))
  if (!m) return null
  const [, indent, marker, num, delim, gap, task = '', content] = m
  if (pos - start < indent.length + marker.length + gap.length + task.length) return null // caret in the marker
  if (!content.trim()) return { from: start, to: end, text: '' }
  const next = indent + (num ? `${Number(num) + 1}${delim}` : marker) + gap + (task ? '[ ] ' : '')
  return { from: pos, to: pos, text: '\n' + next }
}

/** Tab / Shift+Tab: indent (or outdent) every line the selection touches. A bare Tab on a line that
 *  is not a list item just types spaces. */
export function indentLines(value: string, s: number, e: number, back: boolean): Edit {
  if (!back && s === e && !ITEM.test(value.slice(value.lastIndexOf('\n', s - 1) + 1, (value.indexOf('\n', s) + 1 || value.length + 1) - 1)))
    return { from: s, to: e, text: INDENT }
  const last = e > s && value[e - 1] === '\n' ? e - 1 : e
  const start = value.lastIndexOf('\n', s - 1) + 1
  const stop = value.indexOf('\n', last)
  const end = stop < 0 ? value.length : stop
  const old = value.slice(start, end)
  const text = old
    .split('\n')
    .map((l) => (back ? l.replace(/^( {1,4}|\t)/, '') : l ? INDENT + l : l))
    .join('\n')
  const caret = Math.max(start, s + text.length - old.length)
  return { from: start, to: end, text, sel: s === e ? [caret, caret] : [start, start + text.length] }
}

/** The `[[query` the caret is in: where the `[[` starts and what follows it, else null. */
export function wikiQuery(value: string, pos: number): { start: number; q: string } | null {
  const m = /\[\[([^[\]|#\n]*)$/.exec(value.slice(0, pos))
  return m ? { start: m.index, q: m[1] } : null
}

/** Note keys matching `q`, best first: file name starts with it, contains it, then only the folder does. */
export function pickNotes(keys: string[], q: string, max = 8): string[] {
  const n = q.normalize('NFKC').toLowerCase().trim()
  const name = (k: string) => (k.split('/').pop() ?? k).replace(/\.(md|html?)$/i, '').toLowerCase()
  const rank = (k: string) => (name(k).startsWith(n) ? 0 : name(k).includes(n) ? 1 : 2)
  return keys
    .filter((k) => k.toLowerCase().includes(n))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
    .slice(0, max)
}
