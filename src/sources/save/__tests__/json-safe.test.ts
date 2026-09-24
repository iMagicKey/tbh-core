import { describe, expect, it } from 'vitest'
import { bigIntSafeJsonParse, quoteBigIntLiterals } from '../json-safe'

describe('quoteBigIntLiterals / bigIntSafeJsonParse', () => {
  it('quotes bare 16+-digit integer literals outside strings', () => {
    const input = '{"a":9007199254740993,"b":-18446744073709551615,"c":123456789012345}'
    const parsed = bigIntSafeJsonParse(input) as Record<string, unknown>
    expect(parsed['a']).toBe('9007199254740993')
    expect(parsed['b']).toBe('-18446744073709551615')
    expect(parsed['c']).toBe(123456789012345) // 15 digits stay a Number
  })

  it('never modifies digits inside string literals', () => {
    const input = '{"note":"ticket 12345678901234567890 here","a":9007199254740993}'
    const quoted = quoteBigIntLiterals(input)
    expect(quoted).toContain('"ticket 12345678901234567890 here"') // string content untouched
    expect(quoted).toContain('"9007199254740993"') // bare literal quoted
  })

  it('leaves floats and scientific notation untouched', () => {
    const input = '{"x":2.154e7,"y":1.5,"big":99999999999999999999}'
    const parsed = bigIntSafeJsonParse(input) as Record<string, unknown>
    expect(parsed['x']).toBe(21540000)
    expect(parsed['y']).toBe(1.5)
    expect(parsed['big']).toBe('99999999999999999999')
  })

  it('handles arrays of big ids (equippedItemIds shape)', () => {
    const input = '{"equippedItemIds":[9007199254740993,123,18446744073709551615]}'
    const parsed = bigIntSafeJsonParse(input) as Record<string, unknown>
    expect(parsed['equippedItemIds']).toEqual(['9007199254740993', 123, '18446744073709551615'])
  })

  it('handles escaped quotes inside strings while tracking state', () => {
    const input = '{"s":"say \\"9007199254740993\\" ok","n":9007199254740994}'
    const parsed = bigIntSafeJsonParse(input) as Record<string, unknown>
    expect(parsed['s']).toBe('say "9007199254740993" ok') // inner digits not quoted
    expect(parsed['n']).toBe('9007199254740994')
  })

  it('round-trips exact ids through parse + stringify', () => {
    const id = '18446744073709551615'
    const parsed = bigIntSafeJsonParse(`{"uid":${id}}`) as Record<string, unknown>
    expect(JSON.stringify(parsed)).toBe(`{"uid":"${id}"}`)
  })
})
