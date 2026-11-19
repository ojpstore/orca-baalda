// Reads a Chromium LevelDB folder (the Baalda webview's localStorage): sorted tables (.ldb,
// snappy blocks) plus the write-ahead log (.log). Read-only, enough for a few small keys.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function varint(b: Buffer, i: number): [number, number] {
  let r = 0
  let s = 0
  for (;;) {
    const c = b[i++]
    r += (c & 127) * 2 ** s
    s += 7
    if (c < 128) return [r, i]
  }
}

function snappy(b: Buffer): Buffer {
  let [n, i] = varint(b, 0)
  const o = Buffer.alloc(n)
  let w = 0
  while (i < b.length) {
    const t = b[i++]
    let len: number
    let off: number
    if ((t & 3) === 0) {
      len = t >> 2
      if (len >= 60) {
        const nb = len - 59
        len = b.readUIntLE(i, nb)
        i += nb
      }
      len++
      b.copy(o, w, i, i + len)
      i += len
      w += len
      continue
    }
    if ((t & 3) === 1) {
      len = ((t >> 2) & 7) + 4
      off = ((t >> 5) << 8) | b[i++]
    } else if ((t & 3) === 2) {
      len = (t >> 2) + 1
      off = b.readUInt16LE(i)
      i += 2
    } else {
      len = (t >> 2) + 1
      off = b.readUInt32LE(i)
      i += 4
    }
    for (let k = 0; k < len; k++, w++) o[w] = o[w - off]
  }
  return o
}

function* entries(b: Buffer): Generator<[Buffer, Buffer]> {
  const restarts = b.readUInt32LE(b.length - 4)
  const end = b.length - 4 - 4 * restarts
  let i = 0
  let key = Buffer.alloc(0)
  while (i < end) {
    let shared, own, vlen
    ;[shared, i] = varint(b, i)
    ;[own, i] = varint(b, i)
    ;[vlen, i] = varint(b, i)
    key = Buffer.concat([key.subarray(0, shared), b.subarray(i, i + own)])
    i += own
    yield [key, b.subarray(i, i + vlen)]
    i += vlen
  }
}

/** Latest value of every live key: user key (latin1) → raw value. */
export async function readLevelDb(dir: string): Promise<Map<string, Buffer>> {
  const best = new Map<string, { seq: number; value: Buffer | null }>()
  const put = (key: Buffer, seq: number, value: Buffer | null) => {
    const k = key.toString('latin1')
    if ((best.get(k)?.seq ?? -1) <= seq) best.set(k, { seq, value })
  }
  const files = (await readdir(dir)).sort()
  for (const name of files.filter((f) => f.endsWith('.ldb'))) {
    const f = await readFile(join(dir, name))
    const block = (off: number, size: number) => (f[off + size] === 1 ? snappy(f.subarray(off, off + size)) : f.subarray(off, off + size))
    const foot = f.subarray(f.length - 48)
    let [, j] = varint(foot, 0)
    ;[, j] = varint(foot, j)
    const [io, j2] = varint(foot, j)
    const [isz] = varint(foot, j2)
    for (const [, h] of entries(block(io, isz))) {
      const [o, k] = varint(h, 0)
      const [s] = varint(h, k)
      for (const [ik, v] of entries(block(o, s))) {
        const tag = ik.readBigUInt64LE(ik.length - 8)
        put(ik.subarray(0, -8), Number(tag >> 8n), (tag & 0xffn) === 1n ? v : null)
      }
    }
  }
  for (const name of files.filter((f) => f.endsWith('.log'))) {
    const f = await readFile(join(dir, name))
    // 32 KiB blocks of records (crc 4, length 2, type 1); FIRST/MIDDLE/LAST pieces join into one batch.
    let batch: Buffer[] = []
    for (let i = 0; i + 7 <= f.length; ) {
      if (32768 - (i % 32768) < 7) {
        i += 32768 - (i % 32768)
        continue
      }
      const len = f.readUInt16LE(i + 4)
      const type = f[i + 6]
      if (type === 0 && len === 0) break
      batch.push(f.subarray(i + 7, i + 7 + len))
      i += 7 + len
      if (type !== 1 && type !== 4) continue
      const b = Buffer.concat(batch)
      batch = []
      let seq = Number(b.readBigUInt64LE(0))
      let p = 12
      while (p < b.length) {
        const live = b[p++] === 1
        let kl, vl
        ;[kl, p] = varint(b, p)
        const key = b.subarray(p, p + kl)
        p += kl
        let value: Buffer | null = null
        if (live) {
          ;[vl, p] = varint(b, p)
          value = b.subarray(p, p + vl)
          p += vl
        }
        put(key, seq++, value)
      }
    }
  }
  const out = new Map<string, Buffer>()
  for (const [k, { value }] of best) if (value) out.set(k, value)
  return out
}

/** A Chromium localStorage value: a 0 byte then UTF-16LE, or a 1 byte then Latin-1. */
export const storageText = (v: Buffer) => (v[0] === 0 ? v.subarray(1).toString('utf16le') : v.subarray(1).toString('latin1'))
