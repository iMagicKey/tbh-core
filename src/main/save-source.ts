// Save source lifecycle + narrow IPC wiring (main process only).
//
// IPC surface (all invoke, all typed, no raw data):
//   save:get-status     -> SaveSourceStatus (no secrets)
//   save:get-summary    -> SaveSummaryDto   (compact view of the last good checkpoint)
//   save:refresh        -> SaveSourceStatus (forced re-discovery)
//   save:select-file    -> SaveSourceStatus (native dialog; persists customSavePath)
//   save:select-game-dir-> SaveSourceStatus (native dialog; persists customGamePath)
//
// The ES3 password never crosses IPC and never appears in any returned object or log line.

import { dialog, ipcMain } from 'electron'
import type { SaveSourceStatus, SaveSummaryDto } from '../shared/save-source'
import { SaveCheckpointSource } from '../sources/save/SaveCheckpointSource'
import { manualPasswordFromEnv } from '../sources/save/password'
import { loadSettings, saveSettings } from './settings'

let source: SaveCheckpointSource | null = null

/** The running source, or null before initSaveSource() / after app teardown. */
export function getSaveSource(): SaveCheckpointSource | null {
  return source
}

function buildSummary(status: SaveSourceStatus): SaveSummaryDto {
  const checkpoint = source?.getLastCheckpoint() ?? null
  return {
    state: status.state,
    reasonCode: status.reasonCode,
    detail: status.detail,
    savePath: status.savePath,
    saveVersion: checkpoint?.saveVersion ?? null,
    lastCheckpointAt: checkpoint?.observedAtMs ?? null,
    currentStageKey: checkpoint?.currentStageKey ?? null,
    currentStageWave: checkpoint?.currentStageWave ?? null,
    walletGold: checkpoint?.walletGold ?? null,
    combatGoldEarned: checkpoint?.aggregates.combatGoldEarned ?? null,
    playTimeSeconds: checkpoint?.playTimeSeconds ?? null,
    heroCount: checkpoint ? checkpoint.heroes.length : null,
    passwordProvenance: status.passwordProvenance,
  }
}

/**
 * Create the save source WITHOUT starting it. Phase C startup ordering:
 * the database initializes first, persistence listeners attach, and only then
 * does the caller call source.start() — the first checkpoint is never missed.
 */
export async function createSaveSource(): Promise<SaveCheckpointSource> {
  if (source) return source
  const settings = await loadSettings()
  source = new SaveCheckpointSource({
    customSavePath: settings.customSavePath ?? null,
    customGamePath: settings.customGamePath ?? null,
    // session-only manual override; never persisted, never logged, never crosses IPC
    manualPassword: manualPasswordFromEnv(),
  })
  return source
}

export function registerSaveSourceIpc(): void {
  ipcMain.handle('save:get-status', () => source?.getState() ?? null)

  ipcMain.handle('save:get-summary', () => {
    const status = source?.getState()
    return status ? buildSummary(status) : null
  })

  ipcMain.handle('save:refresh', async () => {
    if (!source) return null
    await source.refresh()
    return source.getState()
  })

  ipcMain.handle('save:select-file', async () => {
    if (!source) return null
    const result = await dialog.showOpenDialog({
      title: 'Select Task Bar Hero save file',
      properties: ['openFile'],
      filters: [{ name: 'Task Bar Hero save', extensions: ['es3'] }],
    })
    const picked = result.filePaths[0]
    if (picked) {
      await saveSettings({ customSavePath: picked })
      await source.refresh({ customSavePath: picked })
    }
    return source.getState()
  })

  ipcMain.handle('save:select-game-dir', async () => {
    if (!source) return null
    const result = await dialog.showOpenDialog({
      title: 'Select Task Bar Hero installation directory',
      properties: ['openDirectory'],
    })
    const picked = result.filePaths[0]
    if (picked) {
      await saveSettings({ customGamePath: picked })
      await source.refresh({ customGamePath: picked })
    }
    return source.getState()
  })
}
