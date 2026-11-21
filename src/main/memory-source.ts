// Electron glue for the MemorySource: helper path resolution (packaged
// extraResources / dev build / dev env override), source lifecycle, and the
// three narrow IPC channels. The renderer never sees the helper path, PIDs,
// addresses, or raw protocol.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, ipcMain } from 'electron'
import { MemorySource } from '../sources/memory/MemorySource'
import type { HelperTransport } from '../sources/memory/HelperProcess'
import type { MemorySourceStatus } from '../sources/memory/types'

let source: MemorySource | null = null
let readerPathResolved: string | null = null

/**
 * Helper executable resolution:
 *  1. TBH_CORE_READER_PATH env override (developer-only);
 *  2. packaged: <resources>/reader/tbh-core-reader.exe (electron-builder extraResources);
 *  3. dev: locally built helper under helper/memory-reader/dist/...
 * Never a renderer-controlled picker.
 */
export function resolveReaderPath(): string | null {
  if (readerPathResolved !== null) return readerPathResolved
  const candidates: string[] = []
  const envOverride = process.env['TBH_CORE_READER_PATH']
  if (envOverride) candidates.push(envOverride)
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'reader', 'tbh-core-reader.exe'))
  } else {
    candidates.push(path.join(process.cwd(), 'helper', 'memory-reader', 'dist',
      'tbh-core-reader', 'tbh-core-reader.exe'))
  }
  readerPathResolved = candidates.find((candidate) => existsSync(candidate)) ?? ''
  return readerPathResolved || null
}

export function getMemorySource(): MemorySource | null {
  return source
}

export function createMemorySource(): MemorySource | null {
  if (source) return source
  const readerPath = resolveReaderPath()
  if (!readerPath) return null // surfaced as HELPER_MISSING via IPC status
  source = new MemorySource({
    spawnHelper: () => {
      const child = spawn(readerPath, [], {
        shell: false, // NEVER a shell — fixed controlled path
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        transport: child as unknown as HelperTransport,
        stop: () => {
          try {
            child.kill()
          } catch {
            // already dead
          }
        },
      }
    },
  })
  return source
}

function statusWithAvailability(): MemorySourceStatus | null {
  if (source) return source.getState()
  if (!resolveReaderPath()) {
    return {
      state: 'disconnected',
      reasonCode: 'HELPER_MISSING',
      detail: 'memory reader helper not found in this installation',
      gameVersion: null,
      gameFingerprint: null,
      profileId: null,
      readerVersion: null,
      healthEpoch: null,
      lastMessageAt: null,
      lastRejectedRunReason: null,
    }
  }
  return null
}

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:get-status', () => statusWithAvailability())
  ipcMain.handle('memory:get-live', () => source?.getLiveSnapshot() ?? null)
  ipcMain.handle('memory:restart', () => {
    source?.restart()
    return statusWithAvailability()
  })
}
