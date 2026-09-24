import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SaveSourceError } from '../errors'
import {
  extractPasswordFromAssets,
  extractPasswordFromBuffer,
  manualPasswordFromEnv,
  resolveEs3Password,
} from '../password'
import { makeAssetPatternA, makeAssetPatternB } from './fixtures'

const ALNUM_TEST_PASSWORD = 'AssetPass123456'
const PRINTABLE_TEST_PASSWORD = 'Synthetic-Pass.42+'

describe('extractPasswordFromBuffer', () => {
  it('extracts via pattern A (marker + NUL + alphanumeric run)', () => {
    expect(extractPasswordFromBuffer(makeAssetPatternA(ALNUM_TEST_PASSWORD))).toBe(ALNUM_TEST_PASSWORD)
  })

  it('extracts via pattern B (ES3Defaults context + non-printable separator + printable run)', () => {
    expect(extractPasswordFromBuffer(makeAssetPatternB(PRINTABLE_TEST_PASSWORD))).toBe(PRINTABLE_TEST_PASSWORD)
  })

  it('returns null when no plausible structure exists', () => {
    expect(extractPasswordFromBuffer(Buffer.from('nothing relevant here'))).toBeNull()
    const markerOnly = Buffer.concat([Buffer.from('SaveFile_Live.es3'), Buffer.from('\x00short')])
    expect(extractPasswordFromBuffer(markerOnly)).toBeNull()
  })
})

describe('extractPasswordFromAssets', () => {
  it('reads the password from a synthetic install tree (real temp dirs)', () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), makeAssetPatternA(ALNUM_TEST_PASSWORD))
    expect(extractPasswordFromAssets(install)).toEqual({
      password: ALNUM_TEST_PASSWORD,
      assetFile: 'resources.assets',
    })
  })

  it('returns null when no asset carries the structure', () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), Buffer.from('no markers here'))
    expect(extractPasswordFromAssets(install)).toBeNull()
  })

  it('throws GAME_ASSET_UNREADABLE when an asset exists but cannot be read', () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    const assetPath = path.join(dataDir, 'resources.assets')
    writeFileSync(assetPath, Buffer.from('x'))
    try {
      extractPasswordFromAssets(install, {
        readdirSync: (p) => readdirSync(p),
        existsSync: () => true,
        readFileSync: () => {
          throw new Error('EACCES (synthetic)')
        },
      })
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('GAME_ASSET_UNREADABLE')
    }
  })
})

describe('resolveEs3Password', () => {
  it('manual override wins and touches nothing else', () => {
    const resolved = resolveEs3Password({ manualPassword: '  manual-wins  ', gameInstallPath: null })
    expect(resolved.provenance).toBe('manual')
    expect(resolved.password).toBe('manual-wins')
    expect(resolved.assetFile).toBeNull()
  })

  it('throws GAME_INSTALL_NOT_FOUND when no install and no manual password', () => {
    try {
      resolveEs3Password({ gameInstallPath: null })
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('GAME_INSTALL_NOT_FOUND')
    }
  })

  it('throws PASSWORD_NOT_FOUND when extraction finds nothing', () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), Buffer.from('nope'))
    try {
      resolveEs3Password({ gameInstallPath: install })
      expect.unreachable()
    } catch (error) {
      expect((error as SaveSourceError).code).toBe('PASSWORD_NOT_FOUND')
    }
  })

  it('resolves from a synthetic game install', () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'sharedassets0.assets'), makeAssetPatternB(PRINTABLE_TEST_PASSWORD))
    const resolved = resolveEs3Password({ gameInstallPath: install })
    expect(resolved.provenance).toBe('game_asset')
    expect(resolved.assetFile).toBe('sharedassets0.assets')
  })
})

describe('manualPasswordFromEnv', () => {
  it('reads the session-only env override', () => {
    expect(manualPasswordFromEnv({ TBH_CORE_ES3_PASSWORD: ' env-pass ' })).toBe('env-pass')
    expect(manualPasswordFromEnv({})).toBeNull()
    expect(manualPasswordFromEnv({ TBH_CORE_ES3_PASSWORD: '   ' })).toBeNull()
  })
})
