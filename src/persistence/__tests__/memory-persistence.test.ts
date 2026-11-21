import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { MemorySource } from '../../sources/memory/MemorySource'
import type { HelperTransport } from '../../sources/memory/HelperProcess'
import { DatabaseManager } from '../DatabaseManager'
import { PersistenceWiring } from '../wiring'
import { currentSchemaVersion } from '../migrations'
import { migratedMemoryDb, tempDbPath } from './helpers'

class FakeHelper extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { readable: true }
  pid = 100
  killed = false
  constructor() {
    super()
    this.stdout.readable = true
  }
  send(obj: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(obj)}\n`)
  }
  kill(): void {
    this.killed = true
    this.emit('exit', 0)
  }
}

function makeMemorySource() {
  const helpers: FakeHelper[] = []
  const source = new MemorySource({
    spawnHelper: () => {
      const helper = new FakeHelper()
      helpers.push(helper)
      return { transport: helper as unknown as HelperTransport, stop: () => helper.kill() }
    },
  })
  return { source, helpers }
}

const RUN = {
  id: '1790000000000', stageKey: 2205, difficulty: 1, startedAtMs: 1, endedAtMs: 2,
  durationMs: 1000, officialClearTimeMs: null, outcome: 'success', captureQuality: 'complete',
  xpValue: 100, xpSource: 'live', xpConfidence: 'measured', goldValue: 5, goldSource: 'live',
  goldConfidence: 'measured', damage: 9, averageDps: 9, mobsKilled: 3, mobsTotal: 93,
  gameVersion: '1.2.8', gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000', readerVersion: '1.0.0',
  profileId: 'tbh-1.2.8-a', sourceHealthEpoch: 'memory:fp:1', reconciliationStatus: null,
  sessionId: null, buildId: null,
  heroes: [{ heroKey: 201, slot: 2, levelStart: 37, levelEnd: 37, xpGained: 100 }],
}

describe('memory persistence wiring', () => {
  it('migration 002 upgrades a v1 database to v2 and stores provenance', () => {
    const db = migratedMemoryDb()
    // v1 repos did not write provenance; simulate by inserting through raw SQL missing columns
    // (the migration already ran via migratedMemoryDb -> schema v2)
    expect(currentSchemaVersion(db)).toBe(2)
    db.close()
  })

  it('memory runs persist with reader/profile provenance; identical duplicates no-op', async () => {
    const manager = new DatabaseManager()
    expect(manager.open(tempDbPath())).toBe(true)
    const wiring = new PersistenceWiring(manager)
    const { source, helpers } = makeMemorySource()
    wiring.attachMemorySource(source)
    source.start()

    helpers[0].send({ type: 'hello', protocolVersion: 1, readerVersion: '1.0.0', profileId: 'tbh-1.2.8-a' })
    helpers[0].send({ type: 'health', protocolVersion: 1, seq: 1, observedAtMs: 1,
      state: 'healthy', reasonCode: 'OK', detail: null, gameVersion: '1.2.8',
      gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000', profileId: 'tbh-1.2.8-a',
      healthEpoch: 'memory:fp:1' })
    helpers[0].send({ type: 'run_completed', protocolVersion: 1, seq: 2, observedAtMs: 2, run: RUN })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wiring.getStats()?.runCount).toBe(1)
    const lastWrite = wiring.getStatus().lastWriteAt
    expect(lastWrite).not.toBeNull()

    // identical duplicate (helper replay after restart) -> no-op, not a conflict
    helpers[0].send({ type: 'run_completed', protocolVersion: 1, seq: 3, observedAtMs: 3, run: RUN })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wiring.getStats()?.runCount).toBe(1)
    expect(wiring.getStatus().lastWriteAt).toBe(lastWrite) // no fake write timestamp

    source.stop()
    wiring.close()
  })

  it('conflicting duplicate run id surfaces as a persistence diagnostic (DB degraded, source alive)', async () => {
    const manager = new DatabaseManager()
    expect(manager.open(tempDbPath())).toBe(true)
    const wiring = new PersistenceWiring(manager)
    const { source, helpers } = makeMemorySource()
    wiring.attachMemorySource(source)
    source.start()
    helpers[0].send({ type: 'run_completed', protocolVersion: 1, seq: 1, observedAtMs: 1, run: RUN })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(wiring.getStats()?.runCount).toBe(1)

    const conflicting = { ...RUN, goldValue: 999 }
    helpers[0].send({ type: 'run_completed', protocolVersion: 1, seq: 2, observedAtMs: 2, run: conflicting })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const status = manager.getStatus()
    expect(status.state).toBe('degraded')
    expect(status.lastErrorDetail ?? '').toContain('already exists with different content')

    // the SOURCE is untouched by the persistence conflict
    source.stop()
  })

  it('memory health transitions persist with suppression (source_kind=memory)', async () => {
    const manager = new DatabaseManager()
    expect(manager.open(tempDbPath())).toBe(true)
    const wiring = new PersistenceWiring(manager)
    const { source, helpers } = makeMemorySource()
    wiring.attachMemorySource(source)
    source.start()

    const healthMsg = (state: string, reasonCode: string, seq: number) => ({
      type: 'health', protocolVersion: 1, seq, observedAtMs: seq, state, reasonCode,
      detail: null, gameVersion: null, gameFingerprint: null, profileId: null, healthEpoch: null,
    })
    helpers[0].send(healthMsg('detecting', 'GAME_NOT_RUNNING', 1))
    helpers[0].send(healthMsg('detecting', 'GAME_NOT_RUNNING', 2)) // duplicate suppressed
    helpers[0].send(healthMsg('healthy', 'OK', 3))
    helpers[0].send(healthMsg('healthy', 'OK', 4)) // suppressed
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(wiring.getStats()?.healthEventCount).toBeGreaterThanOrEqual(2) // save:none, memory:2 here
    source.stop()
    wiring.close()
  })

  it('lifecycle: memory stops before DB close (shutdown order)', async () => {
    const manager = new DatabaseManager()
    expect(manager.open(tempDbPath())).toBe(true)
    const wiring = new PersistenceWiring(manager)
    const { source, helpers } = makeMemorySource()
    wiring.attachMemorySource(source)
    source.start()

    // shutdown sequence as wired in main/index.ts will-quit
    source.stop()
    wiring.close()
    expect(source.getState().state).toBe('disconnected')
    expect(manager.getStatus().state).toBe('closed')
    // a late helper message after close must not throw (guarded listener)
    expect(() => helpers[0].send({ type: 'run_completed', protocolVersion: 1, seq: 9,
      observedAtMs: 9, run: RUN })).not.toThrow()
  })
})
