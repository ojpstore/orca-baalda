import type { NoteNode } from '../src/protocol'

export const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase()

/**
 * The tree narrowed to names containing `q` (already normalized): a matching folder keeps all it
 * holds, any other folder only its matching descendants. Null when nothing matches.
 */
export function narrow(n: NoteNode, q: string): NoteNode | null {
  if (norm(n.label).includes(q)) return n
  if (n.kind !== 'folder') return null
  const children = (n.children ?? []).map((c) => narrow(c, q)).filter((c): c is NoteNode => c !== null)
  return children.length ? { ...n, children } : null
}
