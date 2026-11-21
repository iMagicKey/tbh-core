import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { MemorySource } from '../MemorySource'
import type { HelperTransport } from '../HelperProcess'

/** A scriptable fake helper: writes JSONL chunks, can crash/exit on demand. */
class FakeHelper extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { readable: true }
  pid = 4242
  killed = false

  constructor() {
    super()
    this.stdout.readable = true
  }

  send(obj: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(obj)}\n`)
  }

  sendRaw(text: string): void {
    this.stdout.emit('data', text)
  }

  kill(): void {
    this.killed = true
    this.emit('exit', 1)
  }

  crash(code: number | null = 1): void {
    this.emit('exit', code)
  }
}

function makeSource() {
  const helpers: FakeHelper[] = []
  const source = new MemorySource({
    spawnHelper: () => {
      const helper = new FakeHelper()
      helpers.push(helper)
      const transport = helper as unknown as HelperTransport
      return { transport, stop: () => helper.kill() }
    },
    backoff: [10, 20, 40],
  })
  return { source, helpers }
}

const HELLO = { type: 'hello', protocolVersion: 1, readerVersion: '1.0.0', profileId: 'tbh-1.2.8-a' }
const HEALTHY = {
  type: 'health', protocolVersion: 1, seq: 1, observedAtMs: 1, state: 'healthy', reasonCode: 'OK',
  detail: null, gameVersion: '1.2.8', gameFingerprint: '1.2.8-0x6ab23e8a-0x6b47000',
  profileId: 'tbh-1.2.8-a', healthEpoch: 'memory:fp:1',
}

describe('MemorySource (fake helper)', () => {
  it('hello captures reader version; healthy state mapped from health messages', () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].send(HELLO)
    helpers[0].send(HEALTHY)
    const status = source.getState()
    expect(status.state).toBe('healthy')
    expect(status.readerVersion).toBe('1.0.0')
    expect(status.gameFingerprint).toBe('1.2.8-0x6ab23e8a-0x6b47000')
    expect(status.healthEpoch).toBe('memory:fp:1')
    source.stop()
    expect(source.getState().state).toBe('disconnected')
    expect(source.getState().reasonCode).toBe('STOPPED')
  })

  it('unsupported fingerprint maps to unsupported_game_version (fail closed)', () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].send(HELLO)
    helpers[0].send({
      ...HEALTHY, state: 'unsupported_game_version', reasonCode: 'UNSUPPORTED_FINGERPRINT',
      detail: "observed '1.3.0-0x1-0x2'; supported '1.2.8-0x6ab23e8a-0x6b47000'",
    })
    expect(source.getState().state).toBe('unsupported_game_version')
    expect(source.getState().reasonCode).toBe('UNSUPPORTED_FINGERPRINT')
    source.stop()
  })

  it('calibration_failed maps from helper calibration_failed/error states', () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].send({
      ...HEALTHY, state: 'calibration_failed', reasonCode: 'CLASS_RESOLUTION_FAILED',
    })
    expect(source.getState().state).toBe('calibration_failed')
    source.stop()
  })

  it('live snapshots and completed runs reach subscribers', () => {
    const { source, helpers } = makeSource()
    source.start()
    const lives: unknown[] = []
    const runs: unknown[] = []
    const rejected: unknown[] = []
    source.onLive((l) => lives.push(l))
    source.onCompletedRun((r) => runs.push(r))
    source.onRunRejected((r) => rejected.push(r))

    helpers[0].send({
      type: 'live', protocolVersion: 1, seq: 2, observedAtMs: 5, gameVersion: '1.2.8',
      gameFingerprint: 'fp', stageKey: 2205, difficulty: 1,
      run: { startedAtMs: 1, elapsedMs: 4000, xpSoFar: 100, goldSoFar: 5, damage: 9, dps: 2,
             mobsKilled: 3, mobsTotal: 93 },
      heroes: [{ heroKey: 201, slot: 2, level: 37, xpSoFar: 40 }],
    })
    expect(lives).toHaveLength(1)
    expect(source.getLiveSnapshot()?.stageKey).toBe(2205)

    helpers[0].send({
      type: 'run_completed', protocolVersion: 1, seq: 3, observedAtMs: 9,
      run: {
        id: '1790000000000', stageKey: 2205, difficulty: 1, startedAtMs: 1, endedAtMs: 2,
        durationMs: 1000, officialClearTimeMs: null, outcome: 'success', captureQuality: 'complete',
        xpValue: 100, xpSource: 'live', xpConfidence: 'measured', goldValue: 5, goldSource: 'live',
        goldConfidence: 'measured', damage: 9, averageDps: 9, mobsKilled: 3, mobsTotal: 93,
        gameVersion: '1.2.8', gameFingerprint: 'fp', readerVersion: '1.0.0', profileId: 'p',
        sourceHealthEpoch: 'e', reconciliationStatus: null, sessionId: null, buildId: null,
        heroes: [{ heroKey: 201, slot: 2, levelStart: 37, levelEnd: 37, xpGained: 100 }],
      },
    })
    expect(runs).toHaveLength(1)

    helpers[0].send({ type: 'run_rejected', protocolVersion: 1, seq: 4, observedAtMs: 10,
      reasonCode: 'STAGE_UNAVAILABLE', detail: 'no catalog stage' })
    expect(rejected).toHaveLength(1)
    expect(source.getState().lastRejectedRunReason?.code).toBe('STAGE_UNAVAILABLE')
    source.stop()
  })

  it('malformed/unknown lines degrade, never crash; protocol mismatch stops WITHOUT restart loop', () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].sendRaw('garbage not json\n{"type":"alien","protocolVersion":1}\n')
    expect(source.getState().state).toBe('detecting') // tolerated noise, still waiting

    helpers[0].send({ type: 'hello', protocolVersion: 99, readerVersion: 'x', profileId: null })
    expect(source.getState().state).toBe('calibration_failed')
    expect(source.getState().reasonCode).toBe('HELPER_PROTOCOL_MISMATCH')
    expect(helpers).toHaveLength(1) // NO restart was spawned
    source.stop()
  })

  it('helper crash restarts with bounded backoff (schedule advances, caps out)', async () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].crash(1)
    expect(source.getState().reasonCode).toBe('HELPER_CRASHED')
    await new Promise((resolve) => setTimeout(resolve, 60)) // > first backoff (10ms)
    expect(helpers.length).toBeGreaterThanOrEqual(2) // restarted
    // second crash advances the backoff; third, fourth... bounded by schedule length
    helpers[1].crash(1)
    helpers[2]?.crash(1)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(helpers.length).toBeLessThanOrEqual(5) // bounded, no rapid loop
    source.stop()
    const attemptsAfterStop = helpers.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(helpers.length).toBe(attemptsAfterStop) // stop() halts the schedule
  })

  it('a healthy-then-crashed helper restarts immediately (game exit case)', async () => {
    const { source, helpers } = makeSource()
    source.start()
    helpers[0].send(HELLO)
    helpers[0].send(HEALTHY)
    helpers[0].crash(0)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(helpers.length).toBe(2) // immediate restart, no long backoff
    source.stop()
  })

  it('restart() respawns the helper on demand', () => {
    const { source, helpers } = makeSource()
    source.start()
    source.restart()
    expect(helpers).toHaveLength(2)
    source.stop()
  })
})
