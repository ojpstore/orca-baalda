// The panel <-> worker contract, declared once: panel/main.ts and src/worker.ts both read it.
export type Vault = { name: string; path: string }
/** 'local': the vault has no server (sync off in Baalda). */
export type Sync = 'synced' | 'pending' | 'local'
/** Folder keys end with '/', note keys are vault-relative paths ending in '.md'. */
export type NoteNode = {
  key: string
  label: string
  /** 'page': an HTML document (Baalda dashboards). */
  kind: 'folder' | 'note' | 'page'
  sync: Sync
  children?: NoteNode[]
}
export type Tree = {
  items: NoteNode[]
  /** Linked to a Baalda server vault (sync turned on in Baalda). */
  remote: boolean
  synced: number
  /** Notes Baalda has not pushed to the server yet. */
  pending: string[]
}

declare module 'orca' {
  interface PluginRequests {
    'vaults.list': { output: { vaults: Vault[]; last: string | null } }
    /** Adds a vault folder by path (must hold Baalda's .context folder). */
    'vault.add': { input: { path: string }; output: Vault }
    /** Shows a folder dialog; adds and answers the chosen vault, or null when cancelled. */
    'vault.pick': { input: { initial: string }; output: { vault: Vault | null } }
    'notes.tree': { input: { vault: string }; output: Tree }
    /** Opens the note in a main-area editor tab. */
    'note.open': { input: { vault: string; path: string }; output: { ok: true } }
    /** Follows a [[wikilink]] or relative link from note `from`; answers the path it opened. */
    'note.goto': { input: { vault: string; from: string; target: string }; output: { path: string } }
    'note.read': { input: { vault: string; path: string }; output: { text: string } }
    'note.write': { input: { vault: string; path: string; text: string }; output: { ok: true } }
    'note.create': {
      input: { vault: string; folder: string; name: string; kind: 'note' | 'folder' }
      output: { path: string }
    }
    /** Starts the Baalda desktop app (the sync engine) if it is not running. */
    'sync.run': { input: { vault: string }; output: { started: boolean; running: boolean } }
  }
  interface PluginPanelEvents {
    /** Something changed on disk in the watched vault (an edit here, in Baalda, or a sync). */
    'notes.changed': { vault: string }
    /** The Baalda tab now shows this note (a click in the panel or a followed link). */
    'note.shown': { vault: string; path: string }
  }
}
