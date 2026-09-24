// BigInt-safe JSON parsing for TBH save payloads.
//
// TBH UniqueIds (UniqueId, ItemUniqueId, equippedItemIds, BoxUniqueId...) are 64-bit values
// that exceed Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991, 16 digits). JSON.parse
// coerces every number to a JS Number FIRST, so converting to string after parsing is too
// late — precision is already lost (Phase A measured ~6 id collisions in 185 items when this
// is done naively).
//
// Strategy (Phase A, tbh-copilot precedent, hardened): before parsing, quote every BARE
// integral literal of 16+ digits directly in the JSON text. 15-digit integers are always
// safe (< 2^53), so only 16+ digit tokens are touched. A small string-aware scanner ensures
// we never modify digits INSIDE string literals.

const SAFE_DIGITS = 15 // max safe integer has 16 digits (9007199254740991); be conservative
const BIG_INT_TOKEN = new RegExp(`^-?\\d{${SAFE_DIGITS + 1},}$`)
const NUMBER_CHARS = new Set('0123456789.eE+-')

/**
 * Quote bare 16+-digit integer literals in a JSON text so JSON.parse yields them as strings.
 * String literals are skipped (tracked with escape awareness); scientific-notation and
 * fractional tokens are left untouched (only pure integer tokens qualify).
 */
export function quoteBigIntLiterals(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      // consume the string literal verbatim (handle escapes)
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '"') break
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    const startsNumber =
      (ch >= '0' && ch <= '9') || (ch === '-' && i + 1 < n && text[i + 1] >= '0' && text[i + 1] <= '9')
    if (!startsNumber) {
      out += ch
      i++
      continue
    }
    // consume the full number token
    let j = i
    while (j < n && NUMBER_CHARS.has(text[j])) j++
    const token = text.slice(i, j)
    out += BIG_INT_TOKEN.test(token) ? `"${token}"` : token
    i = j
  }
  return out
}

/**
 * JSON.parse with exact preservation of 16+-digit integer literals (returned as strings).
 * Everything else parses normally.
 */
export function bigIntSafeJsonParse(text: string): unknown {
  return JSON.parse(quoteBigIntLiterals(text))
}
