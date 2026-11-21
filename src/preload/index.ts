import { contextBridge, ipcRenderer } from 'electron'
import type { SaveSourceStatus, SaveSummaryDto } from '../shared/save-source'
import type { DatabaseStatsDto, DatabaseStatusDto } from '../shared/database'
import type { MemoryLiveDto, MemoryStatusDto } from '../shared/memory-source'

export type UpdateCheckResult =
  | { status: 'disabled-in-dev' }
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

// Narrow, typed save-source surface. No raw file reads, no paths in, no secrets out.
contextBridge.exposeInMainWorld('tbhCore', {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:check-for-updates'),
  getSaveStatus: (): Promise<SaveSourceStatus | null> => ipcRenderer.invoke('save:get-status'),
  getSaveSummary: (): Promise<SaveSummaryDto | null> => ipcRenderer.invoke('save:get-summary'),
  refreshSaveSource: (): Promise<SaveSourceStatus | null> => ipcRenderer.invoke('save:refresh'),
  selectSaveFile: (): Promise<SaveSourceStatus | null> => ipcRenderer.invoke('save:select-file'),
  selectGameDir: (): Promise<SaveSourceStatus | null> => ipcRenderer.invoke('save:select-game-dir'),
  getDatabaseStatus: (): Promise<DatabaseStatusDto | null> => ipcRenderer.invoke('db:get-status'),
  getDatabaseStats: (): Promise<DatabaseStatsDto | null> => ipcRenderer.invoke('db:get-stats'),
  getMemoryStatus: (): Promise<MemoryStatusDto | null> => ipcRenderer.invoke('memory:get-status'),
  getMemoryLive: (): Promise<MemoryLiveDto | null> => ipcRenderer.invoke('memory:get-live'),
  restartMemorySource: (): Promise<MemoryStatusDto | null> => ipcRenderer.invoke('memory:restart'),
})
