import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SaveCheckpointSource } from '../SaveCheckpointSource'
import { TEST_PASSWORD, makeInnerSaveAt, makeSaveFile } from './fixtures'

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

/** Injected monotonic clock the tests can advance without wall-clock waiting. */
function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function baseOptions(clock: ReturnType<typeof makeClock>) {
  return {
    pollIntervalMs: POLL_MS,
    midWriteRetryDelayMs: 5,
    staleAfterMs: 60_000,
    manualPassword: TEST_PASSWORD,
    customSavePath: savePath,
    customGamePath: null,
    now: clock.now,
  }
}

describe('SaveCheckpointSource (real temp filesystem)', () => {
  let source: SaveCheckpointSource
  const checkpoints: unknown[] = []
  const clock = makeClock()

  beforeAll(() => {
    writeSave(makeSaveFile({ gzip: true, innerText: makeInnerSaveAt(clock.now() - 30_000) }), 1_700_000_000_000)
    source = new SaveCheckpointSource(baseOptions(clock))
    source.onCheckpoint((checkpoint) => checkpoints.push(checkpoint))
    source.start()
  })

  afterAll(() => {
    source?.stop()
  })

  it('emits a first checkpoint and reaches healthy (fresh source time)', async () => {
    await until(() => expect(source.getState().state).toBe('healthy'))
    expect(checkpoints).toHaveLength(1)
    const first = source.getLastCheckpoint()
    expect(first?.walletGold).toBe(123_456)
    expect(first?.observedTimeSource).toBe('lastSavedTime')
  })

  it('does not re-decode when mtime and size are unchanged', async () => {
    await until(() => expect(source.getState().lastAttemptAt).not.toBeNull())
    const attemptsBefore = source.getState().lastAttemptAt
    clock.advance(POLL_MS * 6 + 1)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6 + 60))
    expect(source.getState().lastAttemptAt!).toBeGreaterThan(attemptsBefore!) // polls DID run
    expect(checkpoints).toHaveLength(1) // but no new decode/emission
    expect(source.getState().state).toBe('healthy')
  })

  it('emits a new checkpoint when the file changes', async () => {
    writeSave(makeSaveFile({ gzip: false, innerText: makeInnerSaveAt(clock.now() - 10_000) }), 1_700_000_090_000)
    await until(() => expect(checkpoints.length).toBe(2))
    expect(source.getState().state).toBe('healthy')
  })

  it('a torn file keeps the last good checkpoint (degraded MID_WRITE)', async () => {
    const good = makeSaveFile()
    writeSave(Buffer.concat([good.subarray(0, 16), good.subarray(16, 16 + 10)]), 1_700_000_180_000)
    await until(() => expect(source.getState().reasonCode).toBe('MID_WRITE'))
    expect(source.getState().state).toBe('degraded')
    expect(source.getLastCheckpoint()).not.toBeNull() // last good retained
    expect(source.getLastCheckpoint()?.walletGold).toBe(123_456)
  })

  it('recovers to healthy when a valid file replaces the torn one', async () => {
    writeSave(makeSaveFile({ gzip: true, innerText: makeInnerSaveAt(clock.now() - 5_000) }), 1_700_000_270_000)
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
      ...baseOptions(makeClock()),
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
      ...baseOptions(makeClock()),
      manualPassword: null,
      customGamePath: emptyGameDir,
    })
    try {
      noPassword.start()
      writeSave(makeSaveFile(), 1_700_000_450_000)
      await until(() => expect(noPassword.getState().reasonCode).toBe('GAME_INSTALL_NOT_FOUND'))
      expect(noPassword.getState().state).toBe('error')
    } finally {
      noPassword.stop()
    }
  })

  it('stop() stops polling', async () => {
    const stopping = new SaveCheckpointSource(baseOptions(makeClock()))
    stopping.start()
    await until(() =>
      expect(['healthy', 'discovering', 'stale']).toContain(stopping.getState().state),
    )
    stopping.stop()
    expect(stopping.getState().state).toBe('disconnected')
    expect(stopping.getState().reasonCode).toBe('STOPPED')
    const attemptsAtStop = stopping.getState().lastAttemptAt
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5))
    expect(stopping.getState().lastAttemptAt).toBe(attemptsAtStop) // no further polls
  })

  it('the password value never appears in any status object', async () => {
    writeSave(makeSaveFile(), 1_700_000_540_000)
    await until(() => expect(source.getState().state === 'healthy' || source.getState().state === 'stale').toBe(true))
    const serialized = JSON.stringify(source.getState())
    expect(serialized).not.toContain(TEST_PASSWORD)
  })
})

describe('SaveCheckpointSource — MID_WRITE recovers in the SAME poll cycle', () => {
  it('re-reads (not re-decodes) after the file becomes valid during the retry delay', async () => {
    const clock = makeClock(1_710_000_000_000)
    // long retry delay so the test can swap the file mid-retry
    const slow = new SaveCheckpointSource({
      ...baseOptions(clock),
      pollIntervalMs: 3_000,
      midWriteRetries: 3,
      midWriteRetryDelayMs: 400,
    })
    const torn = makeSaveFile()
    writeSave(Buffer.concat([torn.subarray(0, 16), torn.subarray(16, 16 + 10)]), 1_710_000_000_000)
    slow.start()

    // wait until the first (torn) read attempt failed and the source is sleeping in a retry
    await new Promise((resolve) => setTimeout(resolve, 60))
    // replace with a VALID save during the retry sleep window
    writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 1_000) }), 1_710_000_100_000)

    // recovery must arrive well before the next 3s poll would fire
    const recoveredAt = Date.now()
    await until(() => expect(slow.getState().state).toBe('healthy'), 1_200)
    expect(Date.now() - recoveredAt).toBeLessThan(1_200) // same-cycle recovery, not next poll
    expect(slow.getLastCheckpoint()?.walletGold).toBe(123_456)
    slow.stop()
  })
})

describe('SaveCheckpointSource — staleness by SOURCE time', () => {
  it('A) fresh source timestamp -> healthy; D) unchanged file transitions healthy -> stale as time passes', async () => {
    const clock = makeClock(1_720_000_000_000)
    writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 30_000) }), 1_720_000_000_000)
    const src = new SaveCheckpointSource({ ...baseOptions(clock), staleAfterMs: 60_000 })
    try {
      src.start()
      await until(() => expect(src.getState().state).toBe('healthy')) // A: fresh

      clock.advance(5 * 60_000) // D: file unchanged, real (injected) time passes
      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2 + 40))
      await until(() => expect(src.getState().state).toBe('stale'))
      expect(src.getState().reasonCode).toBe('STALE_CHECKPOINT')
      expect(src.getLastCheckpoint()).not.toBeNull() // valid checkpoint, just old
    } finally {
      src.stop()
    }
  })

  it('B) old source timestamp loaded for the first time -> immediately stale', async () => {
    const clock = makeClock(1_730_000_000_000)
    writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 2 * 60 * 60_000) }), 1_730_000_000_000)
    const src = new SaveCheckpointSource({ ...baseOptions(clock), staleAfterMs: 60_000 })
    try {
      src.start()
      await until(() => expect(src.getState().state).toBe('stale')) // never "healthy"
      expect(src.getLastCheckpoint()).not.toBeNull()
      expect(src.getState().reasonCode).toBe('STALE_CHECKPOINT')
    } finally {
      src.stop()
    }
  })

  it('C) stale checkpoint replaced by a new one -> healthy again', async () => {
    const clock = makeClock(1_740_000_000_000)
    writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 2 * 60 * 60_000) }), 1_740_000_000_000)
    const src = new SaveCheckpointSource({ ...baseOptions(clock), staleAfterMs: 60_000 })
    try {
      src.start()
      await until(() => expect(src.getState().state).toBe('stale'))
      writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 1_000) }), 1_740_000_100_000)
      await until(() => expect(src.getState().state).toBe('healthy'))
    } finally {
      src.stop()
    }
  })
})

describe('SaveCheckpointSource — unexpected error safety net', () => {
  it('an injected unexpected readFile failure degrades (SOURCE_INTERNAL_ERROR), keeps last good, and recovers', async () => {
    const clock = makeClock(1_750_000_000_000)
    writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 1_000) }), 1_750_000_000_000)

    let failNextReads = 0
    const io = {
      stat: (p: string) => fsStat(p),
      readFile: (p: string) => {
        if (failNextReads > 0) {
          failNextReads--
          // a NON-ErrnoException, unexpected failure (not a typed condition anywhere)
          return Promise.reject(new TypeError('bonkers injected failure'))
        }
        return fsReadFile(p)
      },
    }
    const src = new SaveCheckpointSource({ ...baseOptions(clock), io })
    const checkpoints: unknown[] = []
    src.onCheckpoint((cp) => checkpoints.push(cp))
    try {
      src.start()
      await until(() => expect(src.getState().state).toBe('healthy'))
      expect(checkpoints).toHaveLength(1)

      failNextReads = 1
      writeSave(makeSaveFile({ innerText: makeInnerSaveAt(clock.now() - 500) }), 1_750_000_100_000)
      await until(() => expect(src.getState().reasonCode).toBe('SOURCE_INTERNAL_ERROR'))
      expect(src.getState().state).toBe('degraded')
      expect(src.getLastCheckpoint()).not.toBeNull() // last good retained

      // the next valid poll recovers and decodes the changed file
      await until(() => expect(checkpoints.length).toBe(2))
      expect(src.getState().state).toBe('healthy')
    } finally {
      src.stop()
    }
  })
})
