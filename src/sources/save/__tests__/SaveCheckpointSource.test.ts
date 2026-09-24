import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SaveCheckpointSource } from '../SaveCheckpointSource'
import { TEST_PASSWORD, makeSaveFile } from './fixtures'

const POLL_MS = 40
const dir = mkdtempSync(path.join(os.tmpdir(), 'tbh-save-src-'))
const savePath = path.join(dir, 'SaveFile_Live.es3')

/** Write a fixture and force a distinct mtime so the poller sees the change. */
function writeSave(content: Buffer, mtimeMs: number): void {
  writeFileSync(savePath, content)
  utimesSync(savePath, new Date(mtimeMs), new Date(mtimeMs))
}

/** Poll an assertion until it holds or the timeout elapses (avoids sleep-based flakiness). */
async function until(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  throw lastError ?? new Error('until() timed out')
}

function makeSource(): SaveCheckpointSource {
  return new SaveCheckpointSource({
    pollIntervalMs: POLL_MS,
    midWriteRetryDelayMs: 5,
    manualPassword: TEST_PASSWORD,
    customSavePath: savePath,
    customGamePath: null,
  })
}

describe('SaveCheckpointSource (real temp filesystem)', () => {
  let source: SaveCheckpointSource
  const checkpoints: unknown[] = []

  beforeAll(() => {
    writeSave(makeSaveFile({ gzip: true }), 1_700_000_000_000)
    source = makeSource()
    source.onCheckpoint((checkpoint) => checkpoints.push(checkpoint))
    source.start()
  })

  afterAll(() => {
    source?.stop()
  })

  it('emits a first checkpoint and reaches healthy', async () => {
    await until(() => expect(source.getState().state).toBe('healthy'))
    expect(checkpoints).toHaveLength(1)
    const first = source.getLastCheckpoint()
    expect(first?.walletGold).toBe(123_456)
    expect(first?.observedTimeSource).toBe('lastSavedTime')
  })

  it('does not re-decode when mtime and size are unchanged', async () => {
    await until(() => expect(source.getState().lastAttemptAt).not.toBeNull())
    const attemptsBefore = source.getState().lastAttemptAt
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6))
    expect(source.getState().lastAttemptAt!).toBeGreaterThan(attemptsBefore!) // polls DID run
    expect(checkpoints).toHaveLength(1) // but no new decode/emission
    expect(source.getState().state).toBe('healthy')
  })

  it('emits a new checkpoint when the file changes', async () => {
    writeSave(makeSaveFile({ gzip: false, innerText: undefined }), 1_700_000_090_000)
    // ensure content differs (mtime differs is enough; playTime variant for realism)
    await until(() => expect(checkpoints.length).toBe(2))
    expect(source.getState().state).toBe('healthy')
  })

  it('a transient mid-write keeps the last good checkpoint and recovers', async () => {
    // torn file: IV + non-block-aligned remainder
    const good = makeSaveFile()
    writeSave(Buffer.concat([good.subarray(0, 16), good.subarray(16, 16 + 10)]), 1_700_000_180_000)
    await until(() => expect(source.getState().reasonCode).toBe('MID_WRITE'))
    expect(source.getState().state).toBe('degraded')
    expect(source.getLastCheckpoint()).not.toBeNull() // last good retained
    expect(source.getLastCheckpoint()?.walletGold).toBe(123_456)

    // restore a good file with a fresh mtime -> recovery
    writeSave(makeSaveFile({ gzip: true }), 1_700_000_270_000)
    await until(() => expect(source.getState().state).toBe('healthy'))
    expect(checkpoints.length).toBe(3)
  })

  it('a wrong password surfaces PASSWORD_INVALID (manual provenance) without losing the last good', async () => {
    writeSave(makeSaveFile({ password: 'not-the-configured-password' }), 1_700_000_360_000)
    await until(() => expect(source.getState().reasonCode).toBe('PASSWORD_INVALID'))
    expect(source.getState().state).toBe('error')
    expect(source.getLastCheckpoint()).not.toBeNull()
  })

  it('missing save file surfaces SAVE_NOT_FOUND', async () => {
    const missing = new SaveCheckpointSource({
      pollIntervalMs: POLL_MS,
      manualPassword: TEST_PASSWORD,
      customSavePath: path.join(dir, 'does-not-exist.es3'),
    })
    try {
      missing.start()
      await until(() => expect(missing.getState().reasonCode).toBe('SAVE_NOT_FOUND'))
      expect(missing.getState().state).toBe('error')
    } finally {
      missing.stop()
    }
  })

  it('no game install and no manual password -> GAME_INSTALL_NOT_FOUND', async () => {
    // an empty custom game dir isolates the test from any REAL Steam install on this machine
    const emptyGameDir = mkdtempSync(path.join(os.tmpdir(), 'tbh-no-game-'))
    const noPassword = new SaveCheckpointSource({
      pollIntervalMs: POLL_MS,
      manualPassword: null,
      customSavePath: savePath,
      customGamePath: emptyGameDir,
    })
    try {
      noPassword.start()
      // password resolution happens only when a changed file is due for decoding
      writeSave(makeSaveFile(), 1_700_000_450_000)
      await until(() => expect(noPassword.getState().reasonCode).toBe('GAME_INSTALL_NOT_FOUND'))
      expect(noPassword.getState().state).toBe('error')
    } finally {
      noPassword.stop()
    }
  })

  it('stop() stops polling', async () => {
    const stopping = makeSource()
    stopping.start()
    await until(() => expect(stopping.getState().state === 'healthy' || stopping.getState().state === 'discovering').toBe(true))
    stopping.stop()
    expect(stopping.getState().state).toBe('disconnected')
    expect(stopping.getState().reasonCode).toBe('STOPPED')
    const attemptsAtStop = stopping.getState().lastAttemptAt
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5))
    expect(stopping.getState().lastAttemptAt).toBe(attemptsAtStop) // no further polls
  })

  it('the password value never appears in any status object', async () => {
    writeSave(makeSaveFile(), 1_700_000_540_000)
    await until(() => expect(source.getState().state).toBe('healthy'))
    const serialized = JSON.stringify(source.getState())
    expect(serialized).not.toContain(TEST_PASSWORD)
  })
})
