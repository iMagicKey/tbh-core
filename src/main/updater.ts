import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateCheckResult =
  | { status: 'disabled-in-dev' }
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { status: 'disabled-in-dev' }

  autoUpdater.autoDownload = false
  autoUpdater.allowPrerelease = app.getVersion().includes('-beta')

  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version

    if (!version || version === app.getVersion()) {
      return { status: 'up-to-date', version: app.getVersion() }
    }

    return { status: 'available', version }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
