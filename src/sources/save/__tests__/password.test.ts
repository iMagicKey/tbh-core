import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile as fsReadFile } from 'node:fs/promises'
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
  it('reads the password from a synthetic install tree (real temp dirs, async contract)', async () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), makeAssetPatternA(ALNUM_TEST_PASSWORD))
    await expect(extractPasswordFromAssets(install)).resolves.toEqual({
      password: ALNUM_TEST_PASSWORD,
      assetFile: 'resources.assets',
    })
  })

  it('returns null when no asset carries the structure', async () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), Buffer.from('no markers here'))
    await expect(extractPasswordFromAssets(install)).resolves.toBeNull()
  })

  it('throws GAME_ASSET_UNREADABLE when an asset exists but cannot be read', async () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    const assetPath = path.join(dataDir, 'resources.assets')
    writeFileSync(assetPath, Buffer.from('x'))
    await expect(
      extractPasswordFromAssets(install, {
        readdirSync: (p) => readdirSync(p),
        existsSync: () => true,
        readFile: () => Promise.reject(new Error('EACCES (synthetic)')),
      }),
    ).rejects.toMatchObject({ code: 'GAME_ASSET_UNREADABLE' })
  })
})

describe('resolveEs3Password', () => {
  it('manual override wins and touches nothing else (resolved without any fs access)', async () => {
    const resolved = await resolveEs3Password({
      manualPassword: '  manual-wins  ',
      gameInstallPath: null,
      io: {
        // any fs access here would fail the test — manual must short-circuit
        readFile: () => Promise.reject(new Error('must not be called')),
      },
    })
    expect(resolved.provenance).toBe('manual')
    expect(resolved.password).toBe('manual-wins')
    expect(resolved.assetFile).toBeNull()
  })

  it('throws GAME_INSTALL_NOT_FOUND when no install and no manual password', async () => {
    await expect(resolveEs3Password({ gameInstallPath: null })).rejects.toMatchObject({
      code: 'GAME_INSTALL_NOT_FOUND',
    })
  })

  it('throws PASSWORD_NOT_FOUND when extraction finds nothing', async () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'resources.assets'), Buffer.from('nope'))
    await expect(resolveEs3Password({ gameInstallPath: install })).rejects.toMatchObject({
      code: 'PASSWORD_NOT_FOUND',
    })
  })

  it('resolves from a synthetic game install (async asset reads awaited)', async () => {
    const install = mkdtempSync(path.join(os.tmpdir(), 'tbh-install-'))
    const dataDir = path.join(install, 'TaskBarHero_Data')
    mkdirSync(dataDir)
    writeFileSync(path.join(dataDir, 'sharedassets0.assets'), makeAssetPatternB(PRINTABLE_TEST_PASSWORD))
    const resolved = await resolveEs3Password({
      gameInstallPath: install,
      // async provider shape (node:fs/promises readFile signature)
      io: { readFile: (p) => fsReadFile(p) },
    })
    expect(resolved.provenance).toBe('game_asset')
    expect(resolved.assetFile).toBe('sharedassets0.assets')
    expect(resolved.password).toBe(PRINTABLE_TEST_PASSWORD)
  })
})

describe('manualPasswordFromEnv', () => {
  it('reads the session-only env override', () => {
    expect(manualPasswordFromEnv({ TBH_CORE_ES3_PASSWORD: ' env-pass ' })).toBe('env-pass')
    expect(manualPasswordFromEnv({})).toBeNull()
    expect(manualPasswordFromEnv({ TBH_CORE_ES3_PASSWORD: '   ' })).toBeNull()
  })
})
