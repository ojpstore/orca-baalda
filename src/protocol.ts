// The panel <-> worker contract, declared once: panel/main.ts and src/worker.ts both read it.
export type Vault = { name: string; path: string }
/** A sync run: Baalda runs hidden ('syncing'), then closes ('done'), or is left running ('timeout'),
 *  or could not reach its server and was closed ('failed', the message says why). */
export type SyncState = 'syncing' | 'done' | 'timeout' | 'failed'
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
    /** `locked`: the vault is read-only here (its notes show no edit button). */
    'notes.tree': { input: { vault: string }; output: Tree & { locked: boolean } }
    /** Notes whose text contains `q` (normalized as panel/filter's norm), at most 500 keys. */
    'notes.search': { input: { vault: string; q: string }; output: { keys: string[] } }
    'vault.lock': { input: { vault: string; locked: boolean }; output: { ok: true } }
    /** Opens the note in a main-area editor tab. */
    'note.open': { input: { vault: string; path: string }; output: { ok: true } }
    /** Follows a [[wikilink]] or relative link from note `from`; answers the path it opened. */
    'note.goto': { input: { vault: string; from: string; target: string }; output: { path: string } }
    /** Notes (documents) that link to `path` with a [[wikilink]] or a relative link, sorted. */
    'note.backlinks': { input: { vault: string; path: string }; output: { paths: string[] } }
    /**
     * Reads an image a note shows (`src` as written in it: a relative path or a bare [[file name]])
     * as base64. Only image files inside the vault (no dot folders) are answered.
     */
    'note.image': { input: { vault: string; from: string; src: string }; output: { mime: string; data: string } }
    /**
     * Saves a pasted image under the vault's `attachments/` folder (refused in a locked vault) and
     * answers the link to it relative to note `from`. Sent in base64 parts like note.write:
     * `offset` counts the base64 characters sent before; `link` is '' until the last part.
     */
    'note.attach': {
      input: { vault: string; from: string; mime: string; data: string; offset?: number; more?: boolean }
      output: { link: string }
    }
    'note.read': { input: { vault: string; path: string }; output: { text: string; locked: boolean } }
    /**
     * Orca caps a frame's request at 65,560 UTF-8 bytes, so the editor sends long notes in parts:
     * `offset` is how much text came before (0 starts over), `more` holds the write for the rest.
     */
    'note.write': {
      input: { vault: string; path: string; text: string; offset?: number; more?: boolean }
      output: { ok: true }
    }
    'note.create': {
      input: { vault: string; folder: string; name: string; kind: 'note' | 'folder' }
      output: { path: string }
    }
    /** Renames a note, page, or folder (folder keys end with '/'). */
    'note.rename': {
      input: { vault: string; path: string; name: string }
      output: { path: string }
    }
    /** Moves a note, page, or folder into `toFolder` ('' for vault root, or 'Folder/'). */
    'note.move': {
      input: { vault: string; from: string; toFolder: string }
      output: { path: string }
    }
    /** Deletes a note, page, or folder: to the Recycle Bin on Windows. Baalda syncs the deletion. */
    'note.delete': { input: { vault: string; path: string }; output: { ok: true } }
    /** Shows the Baalda desktop app's window (hidden by sync.run), or starts it normally. */
    'app.show': { output: { ok: true } }
    /** Reads `text` aloud with Windows' Korean voice, repeating until speech.stop. */
    'speech.start': { input: { text: string }; output: { ok: true } }
    'speech.stop': { output: { ok: true } }
    /** Whether speech is running: the frame may have been recreated while it went on. */
    'speech.state': { output: { on: boolean } }
    /** Starts the Baalda desktop app (the sync engine) with no window if it is not running. */
    'sync.run': { input: { vault: string }; output: { started: boolean; running: boolean } }
  }
  interface PluginPanelEvents {
    /** Something changed on disk in the watched vault (an edit here, in Baalda, or a sync). */
    'notes.changed': { vault: string }
    /** The Baalda tab now shows this note (a click in the panel or a followed link). */
    'note.shown': { vault: string; path: string }
    /** The vault's lock checkbox changed. */
    'vault.locked': { vault: string; locked: boolean }
    /** Progress of the sync button's run. */
    /** Reading stopped on its own (no Korean voice installed). */
    'speech.ended': Record<string, never>
    'sync.status': { vault: string; state: SyncState; message: string; server: string }
  }
}
