import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkForUpdates } from './updater'
import { createSaveSource, getSaveSource, registerSaveSourceIpc } from './save-source'
import { initPersistence, registerPersistenceIpc, shutdownPersistence } from './persistence'
import { createMemorySource, getMemorySource, registerMemoryIpc } from './memory-source'

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

app.whenReady().then(async () => {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:check-for-updates', () => checkForUpdates())
  registerSaveSourceIpc()
  registerPersistenceIpc()
  registerMemoryIpc()

  // Phase D startup ordering: persistence first, then sources are CREATED,
  // listeners attached, and only then started — no first event is ever missed.
  // A missing/failed database or helper degrades that source only — never the app.
  const persistence = initPersistence()
  const saveSource = await createSaveSource().catch(() => null)
  if (persistence && saveSource) {
    persistence.attachTo(saveSource)
  }
  const memorySource = createMemorySource()
  if (persistence && memorySource) {
    persistence.attachMemorySource(memorySource)
  }

  saveSource?.start()
  memorySource?.start()

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
})

app.on('will-quit', () => {
  // Phase D shutdown ordering: memory first (it can emit final events), then
  // the save source, then the database — SQLite never closes before sources stop.
  getMemorySource()?.stop()
  shutdownPersistence(getSaveSource())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
