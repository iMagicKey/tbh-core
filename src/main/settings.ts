// Minimal local settings persistence under Electron's userData directory.
// Local only, no cloud, no telemetry, no registry. Atomic write (tmp + rename).
//
// NOTE: the ES3 password is intentionally NOT persisted here. Plaintext secrets in a local
// JSON are undesirable (Phase B spec / Phase A decision); the manual override is session-only
// via the TBH_CORE_ES3_PASSWORD environment variable. Paths are not secrets and persist.

import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AppSettings {
  customSavePath?: string
  customGamePath?: string
}

let cached: AppSettings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  try {
    const text = await readFile(settingsPath(), 'utf8')
    const parsed: unknown = JSON.parse(text)
    cached = typeof parsed === 'object' && parsed !== null ? (parsed as AppSettings) : {}
  } catch {
    cached = {}
  }
  return cached
}

export async function saveSettings(update: AppSettings): Promise<AppSettings> {
  const current = await loadSettings()
  const next: AppSettings = { ...current, ...update }
  const target = settingsPath()
  const tmp = `${target}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, target)
  cached = next
  return next
}
