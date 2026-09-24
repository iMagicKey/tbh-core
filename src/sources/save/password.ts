// ES3 password resolution — Phase A product decision (recorded 2026-09-24):
//
//   1. explicit user override (env TBH_CORE_ES3_PASSWORD; session-only, never persisted,
//      never crosses IPC);
//   2. automatic extraction from the user's OWN installed game assets;
//   3. failure with a clear diagnostic (GAME_INSTALL_NOT_FOUND / PASSWORD_NOT_FOUND /
//      GAME_ASSET_UNREADABLE).
//
// The historical game password is NOT compiled in and MUST NOT be added.
//
// Extraction evidence (Phase A, save-source.md §2): the ES3 password sits in plaintext in
// the Unity asset files right next to the `SaveFile_Live.es3` filename constant. Two proven
// structural patterns are implemented:
//   A (tbh-codown): marker `SaveFile_Live.es3` [\0]+ then an alphanumeric run of 8..64;
//   B (giba):       `ES3Defaults` within 80 bytes before the marker, then a non-printable
//                   separator and a printable run of 8..40.
//
// The resolved password value NEVER enters logs, status objects, or diagnostics — only its
// provenance does.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { SaveSourceError } from './errors'
import type { PasswordResolution } from './types'

export const ES3_PASSWORD_ENV_VAR = 'TBH_CORE_ES3_PASSWORD'

/** Asset files that may carry the ES3Defaults block, in search order. */
const ASSET_FILE_NAMES = ['resources.assets', 'sharedassets0.assets', 'globalgamemanagers.assets']

const MARKER = 'SaveFile_Live.es3'
const MARKER_CONTEXT = 'ES3Defaults'
const CONTEXT_WINDOW = 80

function isAlnum(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
}
function isPrintable(byte: number): boolean {
  return byte >= 0x21 && byte <= 0x7e
}
/** Candidates that look like path fragments rather than passwords. */
function plausiblePassword(candidate: string): boolean {
  return !/[\\/:]/.test(candidate) && !candidate.includes(MARKER)
}

/**
 * Extract the ES3 password from one asset buffer (pattern A first, then B).
 * Returns the raw candidate or null. Pure; never throws.
 */
export function extractPasswordFromBuffer(buf: Buffer): string | null {
  // Pattern A: marker + NUL separator + alphanumeric run
  let searchFrom = 0
  while (true) {
    const markerAt = buf.indexOf(MARKER, searchFrom, 'latin1')
    if (markerAt < 0) break
    searchFrom = markerAt + 1

    let i = markerAt + MARKER.length
    while (i < buf.length && buf[i] === 0) i++ // skip NUL separators
    let end = i
    while (end < buf.length && isAlnum(buf[end])) end++
    const runLength = end - i
    if (runLength >= 8 && runLength <= 64) {
      const candidate = buf.toString('latin1', i, end)
      if (plausiblePassword(candidate)) return candidate
    }
  }

  // Pattern B: ES3Defaults context before the marker + non-printable separator + printable run
  searchFrom = 0
  while (true) {
    const markerAt = buf.indexOf(MARKER, searchFrom, 'latin1')
    if (markerAt < 0) break
    searchFrom = markerAt + 1

    const contextStart = Math.max(0, markerAt - CONTEXT_WINDOW - MARKER_CONTEXT.length)
    const context = buf.toString('latin1', contextStart, markerAt)
    if (!context.includes(MARKER_CONTEXT)) continue

    let i = markerAt + MARKER.length
    const separatorAt = i
    if (i >= buf.length || isPrintable(buf[i])) continue // require a non-printable separator
    while (i < buf.length && !isPrintable(buf[i])) i++
    let end = i
    while (end < buf.length && isPrintable(buf[end])) end++
    const runLength = end - i
    if (runLength >= 8 && runLength <= 40 && i > separatorAt) {
      const candidate = buf.toString('latin1', i, end)
      if (plausiblePassword(candidate)) return candidate
    }
  }
  return null
}

export interface PasswordIo {
  readFileSync?: (path: string) => Buffer
  existsSync?: (path: string) => boolean
  readdirSync?: (path: string) => string[]
}

/**
 * Extract the password from the game install's asset files.
 * Throws GAME_ASSET_UNREADABLE when an asset exists but cannot be read;
 * returns null when no asset carries a matching structure.
 */
export function extractPasswordFromAssets(
  gameInstallPath: string,
  io: PasswordIo = {},
): { password: string; assetFile: string } | null {
  const read = io.readFileSync ?? readFileSync
  const exists = io.existsSync ?? existsSync
  const listDir = io.readdirSync ?? readdirSync

  // locate the *_Data directory next to the assets
  let dataDir: string | null = null
  try {
    for (const entry of listDir(gameInstallPath)) {
      if (/^taskbarhero_?data$/i.test(entry)) {
        dataDir = path.join(gameInstallPath, entry)
        break
      }
    }
  } catch {
    dataDir = null
  }
  if (!dataDir) return null

  for (const name of ASSET_FILE_NAMES) {
    const assetPath = path.join(dataDir, name)
    if (!exists(assetPath)) continue
    let buf: Buffer
    try {
      buf = read(assetPath)
    } catch (error) {
      throw new SaveSourceError('GAME_ASSET_UNREADABLE', `${name}: ${(error as Error).message}`)
    }
    const found = extractPasswordFromBuffer(buf)
    if (found) return { password: found, assetFile: name }
  }
  return null
}

export interface ResolvePasswordOptions {
  manualPassword?: string | null
  gameInstallPath: string | null
  io?: PasswordIo
}

/**
 * Resolve the ES3 password per the product decision. Order: manual -> game-asset extraction.
 * Typed failures: GAME_INSTALL_NOT_FOUND (no install and no manual password),
 * PASSWORD_NOT_FOUND (install present, extraction found nothing),
 * GAME_ASSET_UNREADABLE (asset read failure).
 */
export function resolveEs3Password(options: ResolvePasswordOptions): PasswordResolution {
  const manual = options.manualPassword?.trim()
  if (manual && manual.length > 0) {
    return { password: manual, provenance: 'manual', assetFile: null }
  }
  if (!options.gameInstallPath) {
    throw new SaveSourceError(
      'GAME_INSTALL_NOT_FOUND',
      'no game installation found and no manual password provided',
    )
  }
  const extracted = extractPasswordFromAssets(options.gameInstallPath, options.io)
  if (!extracted) {
    throw new SaveSourceError('PASSWORD_NOT_FOUND', `no ES3 password structure found in ${options.gameInstallPath}`)
  }
  return { password: extracted.password, provenance: 'game_asset', assetFile: extracted.assetFile }
}

/** Session-only manual override source (env var; the value never crosses IPC or gets stored). */
export function manualPasswordFromEnv(env: { [key: string]: string | undefined } = process.env): string | null {
  const value = env[ES3_PASSWORD_ENV_VAR]
  return value && value.trim().length > 0 ? value.trim() : null
}
