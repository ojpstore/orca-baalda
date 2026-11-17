// Baalda does not store folder colours, so give each folder a stable one from its path.
const PALETTE = ['#e0b43c', '#e5615b', '#8b7cf6', '#4c9aff', '#3fb970', '#f08a3c', '#e264a8', '#2bb5b0']

export function folderColor(key: string): string {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
