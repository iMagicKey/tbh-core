// Memory helper protocol — JSONL on stdout, protocolVersion 1.
//
// The helper's stdout is NEVER trusted blindly: every line is parsed defensively
// (fragmented chunks, CRLF/LF, malformed JSON, unknown types, wrong protocol
// version, oversized lines). A broken helper degrades the source — it can never
// crash Electron main or grow memory unboundedly.

export const PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 1024 * 1024 // 1 MiB per protocol line, hard cap

export type HelperHealthState =
  | 'disconnected'
  | 'detecting'
  | 'healthy'
  | 'degraded'
  | 'unsupported_game_version'
  | 'calibration_failed'
  | 'error'

export interface HelperHello {
  type: 'hello'
  protocolVersion: number
  readerVersion: string | null
  profileId: string | null
}

export interface HelperHealth {
  type: 'health'
  protocolVersion: number
  seq: number
  observedAtMs: number
  state: HelperHealthState
  reasonCode: string
  detail: string | null
  gameVersion: string | null
  gameFingerprint: string | null
  profileId: string | null
  healthEpoch: string | null
}

export interface HelperLiveHero {
  heroKey: number
  slot: number | null
  level: number | null
  xpSoFar: number | null
}

export interface HelperLive {
  type: 'live'
  protocolVersion: number
  seq: number
  observedAtMs: number
  gameVersion: string | null
  gameFingerprint: string | null
  stageKey: number | null
  difficulty: number | null
  run: {
    startedAtMs: number | null
    elapsedMs: number | null
    xpSoFar: number | null
    goldSoFar: number | null
    damage: number | null
    dps: number | null
    mobsKilled: number | null
    mobsTotal: number | null
  }
  heroes: HelperLiveHero[]
}

export interface HelperRunHero {
  heroKey: number
  slot: number | null
  levelStart: number | null
  levelEnd: number | null
  xpGained: number | null
}

export interface HelperRun {
  id: string
  stageKey: number
  difficulty: number | null
  startedAtMs: number
  endedAtMs: number
  durationMs: number
  officialClearTimeMs: number | null
  outcome: 'success' | 'fail' | 'abandoned'
  captureQuality: 'complete' | 'partial'
  xpValue: number | null
  xpSource: string | null
  xpConfidence: string | null
  goldValue: number | null
  goldSource: string | null
  goldConfidence: string | null
  damage: number | null
  averageDps: number | null
  mobsKilled: number | null
  mobsTotal: number | null
  gameVersion: string | null
  gameFingerprint: string | null
  readerVersion: string | null
  profileId: string | null
  sourceHealthEpoch: string | null
  reconciliationStatus: null
  sessionId: null
  buildId: null
  heroes: HelperRunHero[]
}

export interface HelperRunCompleted {
  type: 'run_completed'
  protocolVersion: number
  seq: number
  observedAtMs: number
  run: HelperRun
}

export interface HelperRunRejected {
  type: 'run_rejected'
  protocolVersion: number
  seq: number
  observedAtMs: number
  reasonCode: string
  detail: string | null
}

export type HelperMessage =
  | HelperHello
  | HelperHealth
  | HelperLive
  | HelperRunCompleted
  | HelperRunRejected

export type ParseResult =
  | { ok: true; message: HelperMessage }
  | { ok: false; error: 'malformed-json' | 'not-an-object' | 'unknown-type' | 'protocol-mismatch' | 'oversized' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Runtime guard for ONE parsed protocol line. */
export function parseHelperMessage(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, error: 'not-an-object' }
  const type = value['type']
  if (typeof type !== 'string') return { ok: false, error: 'unknown-type' }
  if (type === 'hello') {
    if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, error: 'protocol-mismatch' }
    return {
      ok: true,
      message: {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        readerVersion: str(value['readerVersion']),
        profileId: str(value['profileId']),
      },
    }
  }
  const seq = numOrNull(value['seq'])
  const observedAtMs = numOrNull(value['observedAtMs'])
  if (type === 'health') {
    if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, error: 'protocol-mismatch' }
    const state = value['state']
    if (typeof state !== 'string' || typeof value['reasonCode'] !== 'string' || seq === null) {
      return { ok: false, error: 'malformed-json' }
    }
    return {
      ok: true,
      message: {
        type: 'health',
        protocolVersion: PROTOCOL_VERSION,
        seq,
        observedAtMs: observedAtMs ?? 0,
        state: state as HelperHealthState,
        reasonCode: value['reasonCode'] as string,
        detail: str(value['detail']),
        gameVersion: str(value['gameVersion']),
        gameFingerprint: str(value['gameFingerprint']),
        profileId: str(value['profileId']),
        healthEpoch: str(value['healthEpoch']),
      },
    }
  }
  if (type === 'live') {
    if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, error: 'protocol-mismatch' }
    const runRec = isRecord(value['run']) ? value['run'] : {}
    const heroesRaw = Array.isArray(value['heroes']) ? value['heroes'] : []
    if (seq === null) return { ok: false, error: 'malformed-json' }
    return {
      ok: true,
      message: {
        type: 'live',
        protocolVersion: PROTOCOL_VERSION,
        seq,
        observedAtMs: observedAtMs ?? 0,
        gameVersion: str(value['gameVersion']),
        gameFingerprint: str(value['gameFingerprint']),
        stageKey: numOrNull(value['stageKey']),
        difficulty: numOrNull(value['difficulty']),
        run: {
          startedAtMs: numOrNull(runRec['startedAtMs']),
          elapsedMs: numOrNull(runRec['elapsedMs']),
          xpSoFar: numOrNull(runRec['xpSoFar']),
          goldSoFar: numOrNull(runRec['goldSoFar']),
          damage: numOrNull(runRec['damage']),
          dps: numOrNull(runRec['dps']),
          mobsKilled: numOrNull(runRec['mobsKilled']),
          mobsTotal: numOrNull(runRec['mobsTotal']),
        },
        heroes: heroesRaw.flatMap((h) => {
          if (!isRecord(h) || typeof h['heroKey'] !== 'number') return []
          return [{
            heroKey: h['heroKey'],
            slot: numOrNull(h['slot']),
            level: numOrNull(h['level']),
            xpSoFar: numOrNull(h['xpSoFar']),
          }]
        }),
      },
    }
  }
  if (type === 'run_completed') {
    if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, error: 'protocol-mismatch' }
    const run = value['run']
    if (!isRecord(run) || typeof run['id'] !== 'string' || typeof run['stageKey'] !== 'number'
        || typeof run['outcome'] !== 'string' || seq === null) {
      return { ok: false, error: 'malformed-json' }
    }
    const heroesRaw = Array.isArray(run['heroes']) ? run['heroes'] : []
    return {
      ok: true,
      message: {
        type: 'run_completed',
        protocolVersion: PROTOCOL_VERSION,
        seq,
        observedAtMs: observedAtMs ?? 0,
        run: {
          id: run['id'],
          stageKey: run['stageKey'],
          difficulty: numOrNull(run['difficulty']),
          startedAtMs: typeof run['startedAtMs'] === 'number' ? run['startedAtMs'] : 0,
          endedAtMs: typeof run['endedAtMs'] === 'number' ? run['endedAtMs'] : 0,
          durationMs: typeof run['durationMs'] === 'number' ? run['durationMs'] : 0,
          officialClearTimeMs: numOrNull(run['officialClearTimeMs']),
          outcome: run['outcome'] as HelperRun['outcome'],
          captureQuality: run['captureQuality'] === 'partial' ? 'partial' : 'complete',
          xpValue: numOrNull(run['xpValue']),
          xpSource: str(run['xpSource']),
          xpConfidence: str(run['xpConfidence']),
          goldValue: numOrNull(run['goldValue']),
          goldSource: str(run['goldSource']),
          goldConfidence: str(run['goldConfidence']),
          damage: numOrNull(run['damage']),
          averageDps: numOrNull(run['averageDps']),
          mobsKilled: numOrNull(run['mobsKilled']),
          mobsTotal: numOrNull(run['mobsTotal']),
          gameVersion: str(run['gameVersion']),
          gameFingerprint: str(run['gameFingerprint']),
          readerVersion: str(run['readerVersion']),
          profileId: str(run['profileId']),
          sourceHealthEpoch: str(run['sourceHealthEpoch']),
          reconciliationStatus: null,
          sessionId: null,
          buildId: null,
          heroes: heroesRaw.flatMap((h) => {
            if (!isRecord(h) || typeof h['heroKey'] !== 'number') return []
            return [{
              heroKey: h['heroKey'],
              slot: numOrNull(h['slot']),
              levelStart: numOrNull(h['levelStart']),
              levelEnd: numOrNull(h['levelEnd']),
              xpGained: numOrNull(h['xpGained']),
            }]
          }),
        },
      },
    }
  }
  if (type === 'run_rejected') {
    if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, error: 'protocol-mismatch' }
    if (typeof value['reasonCode'] !== 'string' || seq === null) {
      return { ok: false, error: 'malformed-json' }
    }
    return {
      ok: true,
      message: {
        type: 'run_rejected',
        protocolVersion: PROTOCOL_VERSION,
        seq,
        observedAtMs: observedAtMs ?? 0,
        reasonCode: value['reasonCode'],
        detail: str(value['detail']),
      },
    }
  }
  return { ok: false, error: 'unknown-type' }
}

/**
 * Incremental JSONL line splitter: handles fragmented stdout chunks, multiple
 * lines per chunk, LF and CRLF, and caps the pending buffer (an oversized line
 * is drained and reported, never buffered forever).
 */
export class JsonlLineBuffer {
  private buffer = ''
  private skipping = false

  constructor(
    private readonly maxBytes: number = MAX_LINE_BYTES,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
  ) {}

  push(chunk: string): void {
    if (this.skipping) {
      // an oversized line was drained: discard everything up to its newline
      const skipTo = chunk.indexOf('\n')
      if (skipTo < 0) return
      chunk = chunk.slice(skipTo + 1)
      this.skipping = false
    }
    this.buffer += chunk
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) this.onLine(line)
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = ''
      this.skipping = true
      this.onOverflow()
    }
  }

  /** Flush a trailing line without newline (helper exit). */
  flush(): void {
    const line = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    if (line.length > 0 && !this.skipping) this.onLine(line)
    this.skipping = false
  }
}
