import type { NoteNode } from '../src/protocol'

export const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase()

/**
 * The tree narrowed to names containing `q` (already normalized) or notes in `content` (keys whose
 * text matched): a folder matching by name keeps all it holds, any other folder only its matching
 * descendants. Null when nothing matches.
 */
export function narrow(n: NoteNode, q: string, content: ReadonlySet<string> = new Set()): NoteNode | null {
  if (norm(n.label).includes(q) || content.has(n.key)) return n
  if (n.kind !== 'folder') return null
  const children = (n.children ?? []).map((c) => narrow(c, q, content)).filter((c): c is NoteNode => c !== null)
  return children.length ? { ...n, children } : null
}
