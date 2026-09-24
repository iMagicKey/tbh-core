import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { decodeEs3File, decryptEs3 } from '../es3'
import { SaveSourceError } from '../errors'
import {
  BIG_ID_A,
  BIG_ID_B,
  TEST_PASSWORD,
  KNOWN_TICKS,
  encryptEs3Like,
  makeInnerSaveText,
  makeOuterText,
  makeSaveFile,
} from './fixtures'

describe('decryptEs3', () => {
  it('decrypts with the correct password (valid PKCS7)', () => {
    const file = makeSaveFile()
    const plaintext = decryptEs3(file, TEST_PASSWORD)
    expect(plaintext.subarray(0, 1).toString('latin1')).toBe('{')
    const round = JSON.parse(plaintext.toString('utf8'))
    expect(round.PlayerSaveData.value).toBeTypeOf('string')
  })

  it('rejects a wrong password with PASSWORD_INVALID', () => {
    const file = makeSaveFile()
    try {
      decryptEs3(file, 'definitely-wrong-password')
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('PASSWORD_INVALID')
    }
  })

  it('classifies a block-misaligned payload as transient MID_WRITE', () => {
    const file = makeSaveFile()
    const torn = Buffer.concat([file.subarray(0, 16), file.subarray(16, 16 + 10)]) // IV + 10 bytes
    try {
      decryptEs3(torn, TEST_PASSWORD)
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('MID_WRITE')
    }
  })
})

describe('decodeEs3File', () => {
  it('decodes outer JSON and nested PlayerSaveData.value', () => {
    const decoded = decodeEs3File(makeSaveFile(), TEST_PASSWORD)
    const inner = decoded.inner as Record<string, unknown>
    expect(inner['commonSaveData']).toBeTypeOf('object')
    expect(decoded.outer['PlayerSaveData']).toBeTypeOf('object')
  })

  it('decodes gzip-compressed payloads', () => {
    const file = makeSaveFile({ gzip: true })
    // sanity: the plaintext really was gzipped
    const raw = decryptEs3(file, TEST_PASSWORD)
    expect(raw[0]).toBe(0x1f)
    expect(gunzipSync(raw).length).toBeGreaterThan(0)

    const decoded = decodeEs3File(file, TEST_PASSWORD)
    expect((decoded.inner as Record<string, unknown>)['commonSaveData']).toBeTypeOf('object')
  })

  it('decodes non-gzip (plain) payloads', () => {
    const file = makeSaveFile({ gzip: false })
    const decoded = decodeEs3File(file, TEST_PASSWORD)
    expect((decoded.inner as Record<string, unknown>)['commonSaveData']).toBeTypeOf('object')
  })

  it('preserves 64-bit ids exactly (> Number.MAX_SAFE_INTEGER)', () => {
    const decoded = decodeEs3File(makeSaveFile(), TEST_PASSWORD)
    const inner = decoded.inner as Record<string, any>
    const hero = inner.heroSaveDatas[0]
    // exact round-trip: string identity, not a precision-mangled Number
    expect(hero.equippedItemIds[0]).toBe(BIG_ID_A)
    expect(hero.equippedItemIds[1]).toBe(BIG_ID_B)
    expect(String(Number(BIG_ID_A))).not.toBe(BIG_ID_A) // proves Number coercion would lose it
    const item = inner.itemSaveDatas[0]
    expect(item.UniqueId).toBe(BIG_ID_A)
    expect(item.RegisterID).toBe(BIG_ID_B)
    // 18-digit .NET ticks also survive as exact strings
    const common = inner.commonSaveData as Record<string, unknown>
    expect(common.lastSavedTime).toBe(KNOWN_TICKS)
  })

  it('fails PARSE_FAILED on malformed outer JSON', () => {
    const brokenOuter = encryptEs3Like(Buffer.from('{"PlayerSaveData": oops', 'utf8'), TEST_PASSWORD)
    try {
      decodeEs3File(brokenOuter, TEST_PASSWORD)
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('PARSE_FAILED')
    }
  })

  it('fails PARSE_FAILED when PlayerSaveData.value is malformed nested JSON', () => {
    const file = makeSaveFile({ innerText: '{not valid json' })
    try {
      decodeEs3File(file, TEST_PASSWORD)
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('PARSE_FAILED')
    }
  })

  it('fails PARSE_FAILED when PlayerSaveData is missing', () => {
    const file = encryptEs3Like(Buffer.from(JSON.stringify({ somethingElse: 1 }), 'utf8'), TEST_PASSWORD)
    try {
      decodeEs3File(file, TEST_PASSWORD)
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('PARSE_FAILED')
    }
  })

  it('inner text fixture really contains BARE big-int literals (not strings)', () => {
    const text = makeInnerSaveText()
    // the literal appears bare (unquoted) so the precision-safe parse is genuinely exercised
    expect(text).toContain(BIG_ID_A)
    expect(text).not.toContain(`"${BIG_ID_A}"`)
    const outer = makeOuterText(text)
    expect(outer).toContain(`:${BIG_ID_A}`)
  })
})
