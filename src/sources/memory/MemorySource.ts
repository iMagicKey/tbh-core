// MemorySource — the TypeScript half of the memory telemetry source.
//
// Responsibilities: supervise the helper process (bounded backoff, no restart
// on protocol mismatch), validate the JSONL protocol, expose source health +
// live snapshot + completed runs + rejected-run reasons. Knows NOTHING about
// SQLite or Electron (the spawn factory and clocks are injectable).

import type { HelperTransport } from './HelperProcess'
import { JsonlLineBuffer, parseHelperMessage, type HelperMessage } from './protocol'
import type {
  CompletedRunEvent,
  LiveSnapshot,
  MemoryReasonCode,
  MemorySourceStatus,
  MemoryStateName,
  RunRejectedEvent,
} from './types'

export const RESTART_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000]
export const MAX_BACKOFF_MS = 30_000

export interface SpawnHelper {
  (): {
    transport: HelperTransport
    stop(): void
  }
}

type Listener<T> = (value: T) => void

function helperStateToSourceState(state: string): MemoryStateName {
  switch (state) {
    case 'healthy':
      return 'healthy'
    case 'detecting':
      return 'detecting'
    case 'disconnected':
      return 'disconnected'
    case 'degraded':
      return 'degraded'
    case 'unsupported_game_version':
      return 'unsupported_game_version'
    default: // 'calibration_failed' | 'error'
      return 'calibration_failed'
  }
}

export class MemorySource {
  private readonly spawnHelper: SpawnHelper
  private readonly now: () => number
  private readonly backoffSchedule: number[]

  private stopCurrent: (() => void) | null = null
  private running = false
  private restarting = false
  private restartTimer: NodeJS.Timeout | null = null
  private crashCount = 0
  private sawHealthy = false
  private protocolMismatched = false
  private badLineCount = 0

  private state: MemoryStateName = 'disconnected'
  private reasonCode: MemoryReasonCode = 'STOPPED'
  private detail: string | null = null
  private gameVersion: string | null = null
  private gameFingerprint: string | null = null
  private profileId: string | null = null
  private readerVersion: string | null = null
  private healthEpoch: string | null = null
  private lastMessageAt: number | null = null
  private lastRejectedRun: RunRejectedEvent | null = null
  private liveSnapshot: LiveSnapshot | null = null

  private healthListeners = new Set<Listener<MemorySourceStatus>>()
  private liveListeners = new Set<Listener<LiveSnapshot>>()
  private runListeners = new Set<Listener<CompletedRunEvent>>()
  private rejectedListeners = new Set<Listener<RunRejectedEvent>>()

  constructor(options: { spawnHelper: SpawnHelper; now?: () => number; backoff?: number[] }) {
    this.spawnHelper = options.spawnHelper
    this.now = options.now ?? (() => Date.now())
    this.backoffSchedule = options.backoff ?? RESTART_BACKOFF_MS
  }

  // ------------------------------------------------------------------ public

  start(): void {
    if (this.running) return
    this.running = true
    this.protocolMismatched = false
    this.launchHelper()
  }

  stop(): void {
    this.running = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopCurrent?.()
    this.stopCurrent = null
    this.setState('disconnected', 'STOPPED', null)
  }

  restart(): void {
    this.stopCurrent?.()
    this.stopCurrent = null
    this.crashCount = 0
    this.sawHealthy = false
    this.launchHelper()
  }

  getState(): MemorySourceStatus {
    return {
      state: this.state,
      reasonCode: this.reasonCode,
      detail: this.detail,
      gameVersion: this.gameVersion,
      gameFingerprint: this.gameFingerprint,
      profileId: this.profileId,
      readerVersion: this.readerVersion,
      healthEpoch: this.healthEpoch,
      lastMessageAt: this.lastMessageAt,
      lastRejectedRunReason: this.lastRejectedRun
        ? { code: this.lastRejectedRun.reasonCode, detail: this.lastRejectedRun.detail }
        : null,
    }
  }

  getLiveSnapshot(): LiveSnapshot | null {
    return this.liveSnapshot
  }

  onHealthChange(listener: Listener<MemorySourceStatus>): () => void {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }

  onLive(listener: Listener<LiveSnapshot>): () => void {
    this.liveListeners.add(listener)
    return () => this.liveListeners.delete(listener)
  }

  onCompletedRun(listener: Listener<CompletedRunEvent>): () => void {
    this.runListeners.add(listener)
    return () => this.runListeners.delete(listener)
  }

  onRunRejected(listener: Listener<RunRejectedEvent>): () => void {
    this.rejectedListeners.add(listener)
    return () => this.rejectedListeners.delete(listener)
  }

  // ------------------------------------------------------------------ internals

  private launchHelper(): void {
    if (!this.running || this.protocolMismatched) return
    let { transport } = this.spawnHelper()
    const lineBuffer = new JsonlLineBuffer(
      undefined,
      (line) => this.handleLine(line),
      () => {
        this.badLineCount++
        this.setState('degraded', 'HELPER_OUTPUT_INVALID', 'oversized protocol line drained')
      },
    )
    transport.stdout?.on('data', (chunk: string) => {
      this.lastMessageAt = this.now()
      lineBuffer.push(chunk)
    })
    transport.on('exit', (code) => {
      if (this.stopCurrent === null) return // stopped intentionally
      this.stopCurrent = null
      lineBuffer.flush()
      if (!this.running || this.protocolMismatched) return
      this.handleCrash(code)
    })
    transport.on('error', () => {
      // spawn failure (missing executable) — surfaced via exit/crash path
    })
    this.stopCurrent = () => {
      try {
        transport.kill()
      } catch {
        // already dead
      }
    }
    this.setState('detecting', 'GAME_NOT_RUNNING', 'helper starting')
  }

  private handleCrash(code: number | null): void {
    if (this.sawHealthy && this.crashCount === 0) {
      // a healthy helper that died once restarts immediately (game may have exited)
      this.crashCount = 1
      this.scheduleRestart(0)
      return
    }
    const delay = this.backoffSchedule[Math.min(this.crashCount, this.backoffSchedule.length - 1)]
    this.crashCount++
    this.setState('disconnected', 'HELPER_CRASHED', `helper exited (code ${code}); restart in ${delay}ms`)
    this.scheduleRestart(delay)
  }

  private scheduleRestart(delayMs: number): void {
    if (this.restartTimer || !this.running) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.running) this.launchHelper()
    }, delayMs)
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.badLineCount++
      // isolated malformed lines are tolerated noise; a SUSTAINED stream degrades
      if (this.badLineCount >= 5 && this.badLineCount % 25 === 1) {
        this.setState('degraded', 'HELPER_OUTPUT_INVALID', 'malformed JSON line(s) from helper')
      }
      return
    }
    const result = parseHelperMessage(parsed)
    if (!result.ok) {
      if (result.error === 'protocol-mismatch') {
        this.protocolMismatched = true
        this.stopCurrent?.()
        this.stopCurrent = null
        this.setState('calibration_failed', 'HELPER_PROTOCOL_MISMATCH',
          'helper speaks a different protocol version; update TBH Core or the helper')
        return // NO restart loop on mismatch
      }
      this.badLineCount++
      return
    }
    this.handleMessage(result.message)
  }

  private handleMessage(message: HelperMessage): void {
    switch (message.type) {
      case 'hello':
        this.readerVersion = message.readerVersion
        this.profileId = message.profileId ?? this.profileId
        return
      case 'health': {
        if (message.gameVersion) this.gameVersion = message.gameVersion
        if (message.gameFingerprint) this.gameFingerprint = message.gameFingerprint
        if (message.profileId) this.profileId = message.profileId
        if (message.healthEpoch) this.healthEpoch = message.healthEpoch
        const nextState = helperStateToSourceState(message.state)
        if (message.state === 'healthy') {
          this.sawHealthy = true
          this.crashCount = 0
        }
        this.setState(nextState, message.reasonCode as MemoryReasonCode, message.detail)
        return
      }
      case 'live':
        this.liveSnapshot = message
        for (const listener of this.liveListeners) listener(message)
        return
      case 'run_completed':
        for (const listener of this.runListeners) listener(message.run)
        return
      case 'run_rejected':
        this.lastRejectedRun = message
        for (const listener of this.rejectedListeners) listener(message)
        return
    }
  }

  private setState(state: MemoryStateName, reasonCode: MemoryReasonCode, detail: string | null): void {
    const changed = this.state !== state || this.reasonCode !== reasonCode || this.detail !== detail
    this.state = state
    this.reasonCode = reasonCode
    this.detail = detail
    if (changed) {
      const status = this.getState()
      for (const listener of this.healthListeners) listener(status)
    }
  }
}
