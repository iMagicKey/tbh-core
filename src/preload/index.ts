import { contextBridge, ipcRenderer } from 'electron'

export type UpdateCheckResult =
  | { status: 'disabled-in-dev' }
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

contextBridge.exposeInMainWorld('tbhCore', {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:check-for-updates'),
})
