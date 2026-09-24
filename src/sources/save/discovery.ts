// Discovery of the TBH save file and the local game installation (read-only).
//
// Save: the save lives in Unity's persistentDataPath (LocalLow) — NOT in the Steam library.
// Game install: needed only for ES3 password extraction. Windows-first strategy:
//   1. explicit configured path;
//   2. common Steam roots;
//   3. parse libraryfolders.vdf for additional libraries;
//   4. appmanifest_3678970.acf installdir, falling back to common-name probing.
// No registry access, no shell execution, no whole-drive scans.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TBH_STEAM_APP_ID = '3678970'
export const SAVE_FILE_NAME = 'SaveFile_Live.es3'
const SAVE_COMPANY_DIR = 'TesseractStudio'
const SAVE_PRODUCT_DIR = 'TaskbarHero'

/** Default save path (Unity persistentDataPath semantics on Windows). */
export function defaultSavePath(): string {
  const profile = process.env['USERPROFILE'] ?? os.homedir()
  return path.join(profile, 'AppData', 'LocalLow', SAVE_COMPANY_DIR, SAVE_PRODUCT_DIR, SAVE_FILE_NAME)
}

export interface SavePathResolution {
  path: string
  origin: 'default' | 'custom'
}

/** Resolve which save file to use: explicit override wins, otherwise the default path. */
export function resolveSavePath(customSavePath?: string | null): SavePathResolution {
  if (customSavePath && customSavePath.trim().length > 0) {
    return { path: path.resolve(customSavePath.trim()), origin: 'custom' }
  }
  return { path: defaultSavePath(), origin: 'default' }
}

// ---------------------------------------------------------------------------
// Steam library discovery
// ---------------------------------------------------------------------------

/** Common Steam installation roots (no registry / shell execution). */
export function steamRootCandidates(): string[] {
  const roots: string[] = []
  const pf86 = process.env['ProgramFiles(x86)']
  const pf = process.env['ProgramFiles']
  if (pf86) roots.push(path.join(pf86, 'Steam'))
  if (pf) roots.push(path.join(pf, 'Steam'))
  roots.push('C:\\Steam', 'C:\\SteamLibrary')
  // de-duplicate, preserve order
  return [...new Set(roots)]
}

/**
 * Minimal VDF subset parser: extract every quoted `"path"` value from a
 * `libraryfolders.vdf`. Escaped backslashes are unescaped. No dependency needed.
 */
export function parseLibraryFoldersVdf(text: string): string[] {
  const paths: string[] = []
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    paths.push(match[1].replace(/\\\\/g, '\\'))
  }
  return paths
}

/** Extract `"installdir"` from an appmanifest_*.acf (minimal VDF subset). */
export function parseAppManifestInstallDir(text: string): string | null {
  const match = /"installdir"\s+"((?:[^"\\]|\\.)*)"/.exec(text)
  return match ? match[1].replace(/\\\\/g, '\\') : null
}

const DATA_DIR_RE = /^taskbarhero_?data$/i
const INSTALL_NAME_RE = /^task ?bar ?hero$/i

/** Injectable filesystem access for tests. */
export interface DiscoveryIo {
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: 'utf8') => string
  readdirSync?: (path: string) => string[]
  /** Steam roots to search; defaults to the standard candidate list. */
  steamRoots?: string[]
}

/** A directory is a plausible TBH install when it contains a `*TaskBarHero*_Data` folder. */
export function looksLikeGameInstall(dir: string, io: DiscoveryIo = {}): boolean {
  const listDir = io.readdirSync ?? readdirSync
  try {
    const entries = listDir(dir)
    return entries.some((entry) => DATA_DIR_RE.test(entry))
  } catch {
    return false
  }
}

export interface GameInstall {
  path: string
  origin: 'custom' | 'steam-manifest' | 'steam-common-probe'
}

/** Data directory of a game install (e.g. <install>/TaskBarHero_Data). */
export function gameDataDir(install: GameInstall, io: DiscoveryIo = {}): string | null {
  const listDir = io.readdirSync ?? readdirSync
  try {
    const entries = listDir(install.path)
    const hit = entries.find((entry) => DATA_DIR_RE.test(entry))
    return hit ? path.join(install.path, hit) : null
  } catch {
    return null
  }
}

/**
 * Discover the local game installation. Order: custom path -> Steam roots ->
 * libraryfolders.vdf libraries -> appmanifest installdir -> common-name probe.
 * Returns null when nothing plausible exists (no disk scanning beyond the roots above).
 */
export function discoverGameInstall(customGamePath?: string | null, io: DiscoveryIo = {}): GameInstall | null {
  const exists = io.existsSync ?? existsSync
  const read = io.readFileSync ?? readFileSync
  const listDir = io.readdirSync ?? readdirSync

  if (customGamePath && customGamePath.trim().length > 0) {
    const candidate = path.resolve(customGamePath.trim())
    if (looksLikeGameInstall(candidate, io)) return { path: candidate, origin: 'custom' }
    return null
  }

  const libraries: string[] = []
  for (const root of io.steamRoots ?? steamRootCandidates()) {
    if (!exists(root)) continue
    libraries.push(root)
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
    try {
      const text = read(vdf, 'utf8')
      for (const libPath of parseLibraryFoldersVdf(text)) {
        if (exists(libPath)) libraries.push(libPath)
      }
    } catch {
      // unreadable vdf: the root itself is still a candidate
    }
  }

  for (const library of libraries) {
    // preferred: the manifest knows the exact install dir name
    const manifest = path.join(library, 'steamapps', `appmanifest_${TBH_STEAM_APP_ID}.acf`)
    try {
      const installDir = parseAppManifestInstallDir(read(manifest, 'utf8'))
      if (installDir) {
        const candidate = path.join(library, 'steamapps', 'common', installDir)
        if (looksLikeGameInstall(candidate, io)) return { path: candidate, origin: 'steam-manifest' }
      }
    } catch {
      // no / unreadable manifest: fall through to name probing
    }
    // fallback: probe common directory spellings (case-insensitive listing)
    try {
      const common = path.join(library, 'steamapps', 'common')
      for (const entry of listDir(common)) {
        if (INSTALL_NAME_RE.test(entry)) {
          const candidate = path.join(common, entry)
          if (looksLikeGameInstall(candidate, io)) return { path: candidate, origin: 'steam-common-probe' }
        }
      }
    } catch {
      // no common dir in this library
    }
  }
  return null
}
