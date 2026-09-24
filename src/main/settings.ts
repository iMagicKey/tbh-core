// Minimal local settings persistence under Electron's userData directory.
// Local only, no cloud, no telemetry, no registry. Atomic write (tmp + rename).
//
// NOTE: the ES3 password is intentionally NOT persisted here. Plaintext secrets in a local
// JSON are undesirable (Phase B spec / Phase A decision); the manual override is session-only
// via the TBH_CORE_ES3_PASSWORD environment variable. Paths are not secrets and persist.
//
// The file is user-editable local JSON — values are NEVER trusted by type: normalizeSettings
// accepts only non-empty string path overrides and ignores everything else, so malformed
// content can never crash or misconfigure the save source.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AppSettings {
  customSavePath?: string
  customGamePath?: string
}

/**
 * Runtime validation of parsed settings JSON. Only non-empty trimmed strings for the two
 * known path keys survive; arrays, numbers, objects, booleans, null and unknown keys are
 * ignored. Malformed JSON upstream yields `{}`.
 */
export function normalizeSettings(parsed: unknown): AppSettings {
  const out: AppSettings = {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const record = parsed as Record<string, unknown>
  if (typeof record['customSavePath'] === 'string' && record['customSavePath'].trim().length > 0) {
    out.customSavePath = record['customSavePath'].trim()
  }
  if (typeof record['customGamePath'] === 'string' && record['customGamePath'].trim().length > 0) {
    out.customGamePath = record['customGamePath'].trim()
  }
  return out
}

let cached: AppSettings | null = null

/** electron is imported lazily so this module stays loadable in plain Node (unit tests). */
async function settingsPath(): Promise<string> {
  const { app } = await import('electron')
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Never throws: unreadable/corrupt JSON safely produces empty settings. */
export async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  try {
    const text = await readFile(await settingsPath(), 'utf8')
    cached = normalizeSettings(JSON.parse(text))
  } catch {
    cached = {}
  }
  return cached
}

export async function saveSettings(update: AppSettings): Promise<AppSettings> {
  const current = await loadSettings()
  const next: AppSettings = normalizeSettings({ ...current, ...update })
  const target = await settingsPath()
  const tmp = `${target}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, target)
  cached = next
  return next
}
