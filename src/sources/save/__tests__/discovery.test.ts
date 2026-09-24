import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultSavePath,
  discoverGameInstall,
  gameDataDir,
  parseAppManifestInstallDir,
  parseLibraryFoldersVdf,
  resolveSavePath,
} from '../discovery'

describe('save path resolution', () => {
  it('builds the default path from the user profile (LocalLow layout)', () => {
    const expected = path.join(
      process.env['USERPROFILE'] ?? os.homedir(),
      'AppData',
      'LocalLow',
      'TesseractStudio',
      'TaskbarHero',
      'SaveFile_Live.es3',
    )
    expect(defaultSavePath()).toBe(expected)
  })

  it('custom save path override wins', () => {
    expect(resolveSavePath('X:\\saves\\SaveFile_Live.es3')).toEqual({
      path: 'X:\\saves\\SaveFile_Live.es3',
      origin: 'custom',
    })
    expect(resolveSavePath(null).origin).toBe('default')
    expect(resolveSavePath('   ').origin).toBe('default')
  })
})

describe('VDF subset parsers', () => {
  it('extracts library paths with escaped backslashes', () => {
    const vdf = `
"libraryfolders"
{
  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "label" "" }
  "1" { "path" "D:\\\\SteamLibrary" }
}
`
    expect(parseLibraryFoldersVdf(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'])
  })

  it('extracts installdir from an appmanifest', () => {
    const acf = `"appstate"\n{\n  "appid" "3678970"\n  "installdir" "TaskbarHero"\n}`
    expect(parseAppManifestInstallDir(acf)).toBe('TaskbarHero')
    expect(parseAppManifestInstallDir('"appid" "1"')).toBeNull()
  })
})

describe('discoverGameInstall (synthetic Steam layout)', () => {
  function buildLibrary(): { root: string; commonName: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tbh-steam-'))
    const steamapps = path.join(root, 'steamapps')
    mkdirSync(steamapps)
    writeFileSync(
      path.join(steamapps, 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n  "0" { "path" "${root.replace(/\\/g, '\\\\')}" }\n}`,
    )
    writeFileSync(
      path.join(steamapps, 'appmanifest_3678970.acf'),
      `"appstate"\n{\n  "appid" "3678970"\n  "installdir" "TaskbarHero"\n}`,
    )
    const install = path.join(steamapps, 'common', 'TaskbarHero')
    mkdirSync(path.join(install, 'TaskBarHero_Data'), { recursive: true })
    return { root, commonName: 'TaskbarHero' }
  }

  it('finds the install via the appmanifest installdir', () => {
    const { root, commonName } = buildLibrary()
    const install = discoverGameInstall(null, { steamRoots: [root] })
    expect(install).not.toBeNull()
    expect(install?.origin).toBe('steam-manifest')
    expect(path.basename(install!.path)).toBe(commonName)
    expect(gameDataDir(install!)?.endsWith('TaskBarHero_Data')).toBe(true)
  })

  it('falls back to common-name probing when there is no manifest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tbh-steam-'))
    const common = path.join(root, 'steamapps', 'common', 'TaskBarHero')
    mkdirSync(path.join(common, 'TaskBarHero_Data'), { recursive: true })
    const install = discoverGameInstall(null, { steamRoots: [root] })
    expect(install?.origin).toBe('steam-common-probe')
  })

  it('uses the custom game path when it looks like an install', () => {
    const { root, commonName } = buildLibrary()
    const install = discoverGameInstall(path.join(root, 'steamapps', 'common', commonName))
    expect(install?.origin).toBe('custom')
  })

  it('rejects a custom path without a *_Data directory', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'tbh-empty-'))
    expect(discoverGameInstall(empty)).toBeNull()
  })

  it('returns null when nothing plausible exists', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tbh-empty-'))
    expect(discoverGameInstall(null, { steamRoots: [root] })).toBeNull()
  })
})
