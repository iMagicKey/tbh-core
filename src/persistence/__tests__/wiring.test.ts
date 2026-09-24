import { describe, expect, it } from 'vitest'
import { SaveCheckpointSource } from '../../sources/save/SaveCheckpointSource'
import { DatabaseManager } from '../DatabaseManager'
import { PersistenceWiring } from '../wiring'
import { tempDbPath } from './helpers'

const POLL_MS = 40

function makeSource(savePath: string): SaveCheckpointSource {
  return new SaveCheckpointSource({
    pollIntervalMs: POLL_MS,
    manualPassword: 'tbh-core-synthetic-test-password-01',
    customSavePath: savePath,
  })
}

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

describe('PersistenceWiring — source independence and failure behavior', () => {
  it('persists checkpoints and health transitions from a live source (attach before start)', async () => {
    const dbPath = tempDbPath()
    const manager = new DatabaseManager()
    expect(manager.open(dbPath)).toBe(true)
    const wiring = new PersistenceWiring(manager)

    // write a real fixture save the source can decode
    const { makeSaveFile, makeInnerSaveAt } = await import('../../sources/save/__tests__/fixtures')
    const savePath = `${dbPath}.es3`
    const { writeFileSync, utimesSync } = await import('node:fs')
    writeFileSync(savePath, makeSaveFile({ innerText: makeInnerSaveAt(Date.now() - 1_000) }))
    utimesSync(savePath, new Date(1_760_000_000_000), new Date(1_760_000_000_000))

    const source = makeSource(savePath)
    wiring.attachTo(source) // BEFORE start — first events guaranteed
    source.start()

    await until(() => expect(source.getState().state === 'healthy' || source.getState().state === 'stale').toBe(true))
    await until(() => expect(wiring.getStats()?.checkpointCount).toBe(1))
    expect(wiring.getStats()?.healthEventCount ?? 0).toBeGreaterThan(0)

    source.stop()
    wiring.close()
  })

  it('a save-source error is NOT a database error (independent domains)', async () => {
    const manager = new DatabaseManager()
    expect(manager.open(tempDbPath())).toBe(true)
    const wiring = new PersistenceWiring(manager)
    const source = makeSource('Z:\\no\\such\\save.es3')
    wiring.attachTo(source)
    source.start()
    await until(() => expect(source.getState().reasonCode).toBe('SAVE_NOT_FOUND'))
    expect(manager.getStatus().state).toBe('healthy') // DB fine — save error is not a DB error
    source.stop()
    wiring.close()
  })

  it('unavailable database: wiring is inert and the source still works', () => {
    const manager = new DatabaseManager()
    manager.open('Z:\\definitely\\missing\\dir\\x.sqlite3') // fails -> error state
    const wiring = new PersistenceWiring(manager)
    const source = makeSource('Z:\\no\\such\\save.es3')
    expect(() => wiring.attachTo(source)).not.toThrow() // no repos — no listeners attached
    source.start()
    source.stop()
    expect(wiring.getStatus().state).toBe('error')
    expect(wiring.getStats()).toBeNull() // UNAVAILABLE, distinct from all-zero
  })

  it('checkpoint dedupe no-op does NOT advance lastWriteAt (real writes only)', async () => {
    const dbPath = tempDbPath()
    const manager = new DatabaseManager()
    expect(manager.open(dbPath)).toBe(true)
    const wiring = new PersistenceWiring(manager)

    const { makeSaveFile, makeInnerSaveAt } = await import('../../sources/save/__tests__/fixtures')
    const savePath = `${dbPath}.es3`
    const { writeFileSync, utimesSync } = await import('node:fs')
    const innerText = makeInnerSaveAt(Date.now() - 1_000)
    writeFileSync(savePath, makeSaveFile({ innerText })) // fresh IV, same source state
    utimesSync(savePath, new Date(1_760_000_000_000), new Date(1_760_000_000_000))

    const source = makeSource(savePath)
    wiring.attachTo(source)
    source.start()
    await until(() => expect(wiring.getStats()?.checkpointCount).toBe(1))
    const afterFirstWrite = wiring.getStatus().lastWriteAt
    expect(afterFirstWrite).not.toBeNull()

    // rewrite the SAME logical save (identical source state, different bytes/mtime):
    // the source decodes it again, the DB dedupes (no-op) — lastWriteAt must NOT move
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(savePath, makeSaveFile({ innerText })) // new random IV
    utimesSync(savePath, new Date(1_760_000_090_000), new Date(1_760_000_090_000))
    await until(() =>
      expect(source.getState().lastAttemptAt).toBeGreaterThan(1_760_000_090_000),
    )
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(wiring.getStats()?.checkpointCount).toBe(1) // deduped, still one row
    expect(wiring.getStatus().lastWriteAt).toBe(afterFirstWrite) // NO fake "last persisted"
    source.stop()
  })

  it('a checkpoint write failure marks the DB degraded and NEVER breaks the source (guarded listener)', async () => {
    const dbPath = tempDbPath()
    const manager = new DatabaseManager()
    expect(manager.open(dbPath)).toBe(true)
    const wiring = new PersistenceWiring(manager)

    const { makeSaveFile, makeInnerSaveAt } = await import('../../sources/save/__tests__/fixtures')
    const savePath = `${dbPath}.es3`
    const { writeFileSync, utimesSync } = await import('node:fs')
    writeFileSync(savePath, makeSaveFile({ innerText: makeInnerSaveAt(Date.now() - 1_000) }))
    utimesSync(savePath, new Date(1_760_000_000_000), new Date(1_760_000_000_000))

    const source = makeSource(savePath)
    wiring.attachTo(source)
    source.start()
    await until(() => expect(wiring.getStats()?.checkpointCount).toBe(1))
    expect(manager.getStatus().state).toBe('healthy')

    // break persistence mid-flight (schema lost), then force a NEW checkpoint (changed save)
    manager.getDatabase()!.exec('DROP TABLE save_checkpoints')
    writeFileSync(savePath, makeSaveFile({ innerText: makeInnerSaveAt(Date.now() - 500) }))
    utimesSync(savePath, new Date(1_760_000_090_000), new Date(1_760_000_090_000))

    // the only route to 'degraded' is checkpoint #2's guarded write failing against the
    // dropped table — waiting for it also proves the SOURCE survived that failure
    await until(() => expect(manager.getStatus().state).toBe('degraded'))
    expect(source.getLastCheckpoint()).not.toBeNull() // source still holds its checkpoints
    expect(wiring.getStats()).toBeNull() // broken DB -> stats UNAVAILABLE, not zero

    source.stop()
  })
})
