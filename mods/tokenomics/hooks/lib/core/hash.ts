/** FNV-1a over the text's UTF-16 units: a small, stable, unsigned 32-bit hash. Not secret; it only has to spread and to stay put. */
export const fnv1a = (text: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Eight hex digits, for a session id the ledger should know apart from another but not carry whole. */
export const shortHash = (text: string): string => fnv1a(text).toString(16).padStart(8, '0')
