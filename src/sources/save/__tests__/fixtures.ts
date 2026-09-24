// Synthetic ES3 save fixtures — TEST-ONLY.
//
// The password here is unrelated to any real game password. No real save data is committed:
// everything is generated. The inner save is assembled as raw JSON TEXT so bare 64-bit
// integer literals (too large for JS Number) can be embedded exactly — building it via
// JSON.stringify(object) would already lose precision.

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export const TEST_PASSWORD = 'tbh-core-synthetic-test-password-01'

/** IDs beyond Number.MAX_SAFE_INTEGER used across fixtures. */
export const BIG_ID_A = '9007199254740993' // 2^53 + 1 — first value Number cannot represent
export const BIG_ID_B = '18446744073709551615' // 2^64 - 1 — full unsigned 64-bit range

/** .NET ticks for a known instant (2026-01-15T12:00:00Z). */
export const KNOWN_TICKS_MS = Date.UTC(2026, 0, 15, 12, 0, 0)
export const KNOWN_TICKS = String((KNOWN_TICKS_MS + 62_135_596_800_000) * 10_000)

export interface InnerSaveOverrides {
  playTime?: number | string
  currentStageKey?: number
  walletGold?: number
  /** raw JSON fragments spliced into heroSaveDatas[0] */
  heroExtra?: string
  unknownTopLevel?: string
}

/**
 * Raw inner-save JSON text. `__PLACEHOLDER_BIG_ID_A__` / `__PLACEHOLDER_BIG_ID_B__` are
 * replaced with BARE big integer literals (not strings) so the parser's precision handling
 * is exercised end-to-end.
 */
export function makeInnerSaveText(overrides: InnerSaveOverrides = {}): string {
  const text = JSON.stringify({
    __unknownFutureField: { something: ['totally', 'new'] },
    commonSaveData: {
      version: '1.2.8',
      lastSavedTime: '__KNOWN_TICKS__',
      playTime: overrides.playTime ?? 1_234_567,
      currentStageKey: overrides.currentStageKey ?? 2205,
      currentStageWave: 3,
      maxCompletedStage: 2210,
      arrangedHeroKey: [201, 301, 401],
      ArrangedPetKey: 0,
      futureField: 'ignored',
    },
    currenySaveDatas: [
      { Key: 100001, Quantity: overrides.walletGold ?? 123_456 },
      { Key: 200001, Quantity: 42 },
    ],
    heroSaveDatas: [
      {
        heroKey: 201,
        HeroLevel: 35,
        HeroExp: 2.154e7,
        IsUnLock: true,
        equippedItemIds: ['__PLACEHOLDER_BIG_ID_A__', '__PLACEHOLDER_BIG_ID_B__', 12345],
        equippedSKillKey: [1101, 1102],
        __heroFutureField: true,
        ...(overrides.heroExtra ? JSON.parse(overrides.heroExtra) : {}),
      },
      { heroKey: 301, HeroLevel: '35', HeroExp: '22180000,5', IsUnLock: 1, equippedItemIds: [], equippedSKillKey: [] },
    ],
    itemSaveDatas: [
      {
        UniqueId: '__PLACEHOLDER_BIG_ID_A__',
        ItemKey: 300001,
        RegisterID: '__PLACEHOLDER_BIG_ID_B__',
        EnchantData: [{ StatType: 1, StatModKey: 7, Tier: 2, Value: 12.5, RecipeType: 3, ModType: 0 }],
        IsChaotic: false,
      },
      { UniqueId: 12345, ItemKey: 700001, EnchantData: [], futureField: 1 },
    ],
    attributeSaveDatas: [
      { Key: 201003, Level: 4 },
      { Key: 301014, Level: 2 },
    ],
    RuneSaveData: [
      { RuneKey: 110011, Level: 3 },
      { RuneKey: 15002, Level: 1 },
    ],
    aggregateSaveDatas: [
      { Type: 2, SubKey: 1, Value: 11_934_046 },
      { Type: 2, SubKey: 0, Value: 20_000_000 },
      { Type: 13, SubKey: 0, Value: 87 },
      { Type: 14, SubKey: 0, Value: 5 },
    ],
    BoxData: {
      BoxTypes: [1, 0],
      BoxUniqueId: ['__PLACEHOLDER_BIG_ID_B__', '__PLACEHOLDER_BIG_ID_A__'],
      BoxQuantity: [2, 9],
    },
    ...(overrides.unknownTopLevel ? JSON.parse(overrides.unknownTopLevel) : {}),
  })
  return text
    .replace(/"__KNOWN_TICKS__"/g, KNOWN_TICKS) // bare literal: 18-digit ticks would be mangled by Number
    .replace(/"__PLACEHOLDER_BIG_ID_A__"/g, BIG_ID_A)
    .replace(/"__PLACEHOLDER_BIG_ID_B__"/g, BIG_ID_B)
}

/** Outer ES3 container text wrapping the inner save as PlayerSaveData.value. */
export function makeOuterText(innerText: string): string {
  return JSON.stringify({ PlayerSaveData: { __type: 'System.String', value: innerText } })
}

/** Encrypt a plaintext exactly like ES3 does (mirror of the decoder, for fixtures only). */
export function encryptEs3Like(plaintext: Buffer, password: string): Buffer {
  const iv = randomBytes(16)
  const key = pbkdf2Sync(password, iv, 100, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final()])
}

export interface FixtureOptions {
  password?: string
  gzip?: boolean
  innerText?: string
}

/** Full encrypted save fixture (IV || AES-128-CBC), optionally gzip-compressed. */
export function makeSaveFile(options: FixtureOptions = {}): Buffer {
  const password = options.password ?? TEST_PASSWORD
  let plaintext = Buffer.from(makeOuterText(options.innerText ?? makeInnerSaveText()), 'utf8')
  if (options.gzip) plaintext = gzipSync(plaintext)
  return encryptEs3Like(plaintext, password)
}

/** Synthetic game-asset buffer carrying a test password (pattern A: marker + NUL + alnum). */
export function makeAssetPatternA(password: string): Buffer {
  return Buffer.concat([
    Buffer.from('UnityRaw\n\x00\x01some-unity-junk\x00'),
    Buffer.from('ES3Defaults\x00'),
    Buffer.from('SaveFile_Live.es3'),
    Buffer.from('\x00'),
    Buffer.from(password, 'latin1'),
    Buffer.from('\x00SaveFile_Live.es3.es3.tmp\x00'),
  ])
}

/** Synthetic game-asset buffer carrying a test password (pattern B: ES3Defaults context + printable run). */
export function makeAssetPatternB(password: string): Buffer {
  return Buffer.concat([
    Buffer.from('lorem\x01ipsum\x02'),
    Buffer.from('ES3Defaults.somewhere'),
    Buffer.from('SaveFile_Live.es3'),
    Buffer.from('\x01\x02'), // non-printable separators
    Buffer.from(password, 'latin1'),
    Buffer.from('\x00trailing'),
  ])
}
