// Electron glue for the persistence layer: database location, startup wiring
// and the two narrow diagnostics IPC channels (db:get-status, db:get-stats).
//
// No SQL, no raw rows, no file access cross the bridge — status/stats DTOs only.

import { app, ipcMain } from 'electron'
import path from 'node:path'
import { DATABASE_FILENAME, DatabaseManager } from '../persistence/DatabaseManager'
import { PersistenceWiring } from '../persistence/wiring'
import type { SaveCheckpointSource } from '../sources/save/SaveCheckpointSource'

let wiring: PersistenceWiring | null = null

/** The active persistence wiring, or null when uninitialized/unavailable. */
export function getPersistence(): PersistenceWiring | null {
  return wiring
}

/**
 * Open the database under Electron's userData and create the wiring.
 * NEVER throws and NEVER returns null: on database-open failure the wiring
 * still exists so diagnostics can expose the DatabaseManager error, while the
 * repositories are unavailable (inert) and the save source keeps running
 * without persistence.
 */
export function initPersistence(): PersistenceWiring {
  const dbManager = new DatabaseManager()
  const databasePath = path.join(app.getPath('userData'), DATABASE_FILENAME)
  dbManager.open(databasePath) // failure recorded in the manager's error state
  wiring = new PersistenceWiring(dbManager)
  return wiring
}

/**
 * Startup ordering (Phase C contract): database first, then the save source is
 * CREATED, listeners attached, and only then started — the first checkpoint
 * and first health transition can never be missed.
 */
export function registerPersistenceIpc(): void {
  ipcMain.handle('db:get-status', () => wiring?.getStatus() ?? null)
  ipcMain.handle('db:get-stats', () => wiring?.getStats() ?? null)
}

/** App shutdown: detach listeners, stop the source, then close the database. */
export function shutdownPersistence(source: SaveCheckpointSource | null): void {
  wiring?.detach()
  source?.stop()
  wiring?.close()
}
