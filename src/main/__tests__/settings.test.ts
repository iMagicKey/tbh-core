import { describe, expect, it } from 'vitest'
import { normalizeSettings } from '../settings'

describe('normalizeSettings (runtime validation of local settings JSON)', () => {
  it('accepts valid string path overrides', () => {
    expect(normalizeSettings({ customSavePath: 'X:\\saves\\SaveFile_Live.es3', customGamePath: 'D:\\Games\\TaskbarHero' })).toEqual({
      customSavePath: 'X:\\saves\\SaveFile_Live.es3',
      customGamePath: 'D:\\Games\\TaskbarHero',
    })
  })

  it('rejects non-string types without crashing', () => {
    expect(normalizeSettings({ customSavePath: 123 })).toEqual({})
    expect(normalizeSettings({ customGamePath: {} })).toEqual({})
    expect(normalizeSettings({ customSavePath: true, customGamePath: ['a'] })).toEqual({})
    expect(normalizeSettings(null)).toEqual({})
    expect(normalizeSettings([])).toEqual({})
    expect(normalizeSettings('just a string')).toEqual({})
    expect(normalizeSettings(42)).toEqual({})
  })

  it('turns whitespace-only paths into absent keys', () => {
    expect(normalizeSettings({ customSavePath: '   ', customGamePath: '\t\n' })).toEqual({})
  })

  it('trims surrounding whitespace from valid paths', () => {
    expect(normalizeSettings({ customSavePath: '  X:\\save.es3  ' })).toEqual({ customSavePath: 'X:\\save.es3' })
  })

  it('ignores unknown keys (additive schema tolerance)', () => {
    expect(normalizeSettings({ randomFutureSetting: true, another: { nested: 1 }, customSavePath: 'X:\\s.es3' })).toEqual({
      customSavePath: 'X:\\s.es3',
    })
  })

  it('keeps only the known keys when merging updates', () => {
    // saveSettings merge path: current + update pass through the same normalization
    expect(normalizeSettings({ customSavePath: 'X:\\a.es3', customGamePath: 5, bogus: null })).toEqual({
      customSavePath: 'X:\\a.es3',
    })
  })
})
