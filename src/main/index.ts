import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkForUpdates } from './updater'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'TBH Core',
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#09090b',
    show: false,
    webPreferences: {
      preload: path.join(currentDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(currentDir, '../dist/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:check-for-updates', () => checkForUpdates())

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
