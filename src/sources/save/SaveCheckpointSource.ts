// SaveCheckpointSource — read-only polling source for SaveFile_Live.es3.
//
// Responsibilities (and nothing else):
//   * resolve the save path (custom override or default);
//   * resolve the ES3 password (manual env override or async game-asset extraction);
//   * poll file metadata; decode ONLY when mtime/size changed;
//   * read STABLY: stat -> read -> re-stat, verifying size/mtime did not move and the
//     encrypted payload is block-aligned; MID_WRITE retries RE-READ the file (never re-decode
//     a stale torn buffer) so a write completing mid-poll recovers in the SAME cycle;
//   * classify failures with typed codes; a final SOURCE_INTERNAL_ERROR net keeps the source
//     alive (and Electron main un-crashed) on genuinely unexpected errors;
//   * freshness is judged by the CHECKPOINT'S SOURCE TIMESTAMP (observedAtMs = lastSavedTime,
//     fileMtime fallback) — never by when we happened to read it;
//   * retain the last known-good checkpoint across transient failures.
//
// NOT its job: per-run telemetry (memory source), reconciliation, analytics.
// The file is only ever READ — never written, renamed, replaced, or truncated by us.

import { readFile, stat } from 'node:fs/promises'
import type { SaveSourceStatus } from '../../shared/save-source'
import { ES3_IV_LENGTH, decodeEs3File } from './es3'
import { SaveSourceError } from './errors'
import { discoverGameInstall, resolveSavePath } from './discovery'
import { normalizeCheckpoint } from './normalize'
import { resolveEs3Password } from './password'
import type { PasswordResolution, SaveCheckpoint } from './types'

export const SAVE_POLL_INTERVAL_MS = 5_000 // Phase A evidence: save cadence ~1-3 min; 5s poll is comfortable
export const STALE_AFTER_MS = 10 * 60_000 // checkpoint SOURCE time older than this -> stale
export const MID_WRITE_RETRIES = 3 // bounded re-read retries within one poll cycle
export const MID_WRITE_RETRY_DELAY_MS = 150

export interface SaveSourceIo {
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>
  readFile?: (path: string) => Promise<Buffer>
}

interface StableRead {
  bytes: Buffer
  mtimeMs: number
  size: number
  signature: string
}

export interface SaveSourceOptions {
  pollIntervalMs?: number
  staleAfterMs?: number
  midWriteRetries?: number
  midWriteRetryDelayMs?: number
  /** Session-only manual password override (from env in production wiring). */
  manualPassword?: string | null
  customSavePath?: string | null
  customGamePath?: string | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  io?: SaveSourceIo
}

type Listener<T> = (value: T) => void

export class SaveCheckpointSource {
  private readonly pollIntervalMs: number
  private readonly staleAfterMs: number
  private readonly midWriteRetries: number
  private readonly midWriteRetryDelayMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly statFile: NonNullable<SaveSourceIo['stat']>
  private readonly readFile: NonNullable<SaveSourceIo['readFile']>
  private readonly manualPassword: string | null
  private customSavePath: string | null
  private customGamePath: string | null

  private timer: NodeJS.Timeout | null = null
  private running = false
  private polling = false

  private savePath: string | null = null
  private gameInstallPath: string | null = null
  private password: PasswordResolution | null = null

  /** signature (mtimeMs:size) of the last successfully decoded file content */
  private lastDecodedSignature: string | null = null

  private lastGoodCheckpoint: SaveCheckpoint | null = null
  private lastSuccessfulReadAt: number | null = null
  private lastAttemptAt: number | null = null
  private lastError: SaveSourceStatus['lastError'] = null
  private state: SaveSourceStatus['state'] = 'discovering'
  private reasonCode: SaveSourceStatus['reasonCode'] = 'SAVE_FOUND'
  private detail: string | null = null

  private checkpointListeners = new Set<Listener<SaveCheckpoint>>()
  private healthListeners = new Set<Listener<SaveSourceStatus>>()

  constructor(options: SaveSourceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? SAVE_POLL_INTERVAL_MS
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS
    this.midWriteRetries = options.midWriteRetries ?? MID_WRITE_RETRIES
    this.midWriteRetryDelayMs = options.midWriteRetryDelayMs ?? MID_WRITE_RETRY_DELAY_MS
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.statFile = options.io?.stat ?? stat
    this.readFile = options.io?.readFile ?? readFile
    this.manualPassword = options.manualPassword?.trim() || null
    this.customSavePath = options.customSavePath ?? null
    this.customGamePath = options.customGamePath ?? null
  }

  // ------------------------------------------------------------------ public

  start(): void {
    if (this.running) return
    this.running = true
    this.setState('discovering', 'SAVE_FOUND', 'starting discovery')
    void this.poll() // immediate first poll; then scheduled
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.setState('disconnected', 'STOPPED', null)
  }

  /** Force re-discovery (paths + password) and an immediate poll. */
  async refresh(options: { customSavePath?: string | null; customGamePath?: string | null } = {}): Promise<void> {
    if (options.customSavePath !== undefined) this.customSavePath = options.customSavePath
    if (options.customGamePath !== undefined) this.customGamePath = options.customGamePath
    this.password = null // re-resolve (game updates can rotate the password)
    this.lastDecodedSignature = null
    this.setState('discovering', 'SAVE_FOUND', 'refresh requested')
    await this.poll()
  }

  getState(): SaveSourceStatus {
    return {
      state: this.state,
      reasonCode: this.reasonCode,
      detail: this.detail,
      savePath: this.savePath,
      gameInstallPath: this.gameInstallPath,
      passwordProvenance: this.password?.provenance ?? 'none',
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulReadAt: this.lastSuccessfulReadAt, // diagnostics only — NOT freshness
      lastError: this.lastError,
    }
  }

  getLastCheckpoint(): SaveCheckpoint | null {
    return this.lastGoodCheckpoint
  }

  onCheckpoint(listener: Listener<SaveCheckpoint>): () => void {
    this.checkpointListeners.add(listener)
    return () => this.checkpointListeners.delete(listener)
  }

  onHealthChange(listener: Listener<SaveSourceStatus>): () => void {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }

  // ------------------------------------------------------------------ internals

  private setState(
    state: SaveSourceStatus['state'],
    reasonCode: SaveSourceStatus['reasonCode'],
    detail: string | null,
    error?: SaveSourceStatus['lastError'],
  ): void {
    this.state = state
    this.reasonCode = reasonCode
    this.detail = detail
    if (error !== undefined) this.lastError = error
    const status = this.getState()
    for (const listener of this.healthListeners) listener(status)
  }

  private scheduleNextPoll(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) {
      this.scheduleNextPoll()
      return
    }
    this.polling = true
    try {
      await this.pollOnce()
    } catch (error) {
      // Final safety net: a genuinely unexpected failure (programming error, exotic fs
      // condition) must not kill the loop or crash Electron main. Typed failures are
      // handled inside pollOnce; this net is never their replacement.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.setState('degraded', 'SOURCE_INTERNAL_ERROR', message, {
        code: 'SOURCE_INTERNAL_ERROR',
        detail: message,
      })
    } finally {
      this.polling = false
      this.scheduleNextPoll()
    }
  }

  private async pollOnce(): Promise<void> {
    this.lastAttemptAt = this.now()

    // ---- save path (cheap re-resolution: the save can appear when the game first runs)
    const resolved = resolveSavePath(this.customSavePath)
    this.savePath = resolved.path
    let fileStat: { mtimeMs: number; size: number }
    try {
      const st = await this.statFile(resolved.path)
      fileStat = { mtimeMs: st.mtimeMs, size: st.size }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.setState('error', 'SAVE_NOT_FOUND', `save file not found: ${resolved.path}`, {
          code: 'SAVE_NOT_FOUND',
          detail: resolved.path,
        })
      } else {
        this.setState('degraded', 'SAVE_UNREADABLE', `stat failed (${code})`, {
          code: 'SAVE_UNREADABLE',
          detail: String(code),
        })
      }
      return
    }

    const signature = `${fileStat.mtimeMs}:${fileStat.size}`
    if (signature === this.lastDecodedSignature) {
      this.evaluateFreshness()
      return
    }

    // ---- stable read with true re-read retries (a write completing mid-poll recovers NOW,
    // not on the next poll; torn bytes from a failed attempt are never re-decoded)
    const stable = await this.readStableWithRetries(resolved.path)
    if (!stable) {
      // still torn after the bounded budget: transient degraded, signature NOT advanced —
      // the next normal poll retries; last good checkpoint is retained
      this.setState('degraded', 'MID_WRITE', 'save caught mid-write; will retry next poll', {
        code: 'MID_WRITE',
        detail: 'stable read did not converge',
      })
      return
    }

    // ---- password (async asset extraction; resolved lazily, re-resolved on refresh or
    // after an invalid decrypt with the game_asset provenance)
    if (!this.password) {
      this.gameInstallPath = this.discoverInstall()
      try {
        this.password = await resolveEs3Password({
          manualPassword: this.manualPassword,
          gameInstallPath: this.gameInstallPath,
        })
      } catch (error) {
        const err = error instanceof SaveSourceError ? error : new SaveSourceError('SOURCE_INTERNAL_ERROR', String(error))
        this.setState('error', err.code, err.detail, { code: err.code, detail: err.detail })
        return
      }
    }

    // ---- decode + normalize (block constraints already validated by the stable read)
    try {
      const decoded = decodeEs3File(stable.bytes, this.password.password)
      const checkpoint = normalizeCheckpoint(decoded.inner, {
        fileMtimeMs: stable.mtimeMs,
        polledAtMs: this.lastAttemptAt,
        sourcePath: resolved.path,
      })
      this.lastGoodCheckpoint = checkpoint
      this.lastSuccessfulReadAt = this.now()
      this.lastDecodedSignature = stable.signature
      this.lastError = null
      for (const listener of this.checkpointListeners) listener(checkpoint)
      // recover to healthy from ANY prior state (error/degraded included), then judge
      // freshness by the CHECKPOINT'S SOURCE TIME: a successfully decoded but old
      // checkpoint is 'stale', which is not an error
      this.setState('healthy', 'SAVE_FOUND', resolved.origin === 'custom' ? 'custom save path' : null)
      this.evaluateFreshness()
      return
    } catch (error) {
      const err = error instanceof SaveSourceError ? error : new SaveSourceError('DECRYPT_FAILED', String(error))
      if (err.code === 'MID_WRITE') {
        // defensive: the stable read already screens this; classify transient regardless
        this.setState('degraded', 'MID_WRITE', err.detail, { code: 'MID_WRITE', detail: err.detail })
        return
      }
      if (err.code === 'PASSWORD_INVALID') {
        // a game update can rotate the password: drop the cached one and let the next
        // poll re-extract; with a MANUAL password this is a hard error (user must fix it)
        const wasGameAsset = this.password.provenance === 'game_asset'
        this.password = null
        if (wasGameAsset) {
          this.setState('degraded', 'PASSWORD_INVALID', 'decrypt failed; will re-extract password', {
            code: 'PASSWORD_INVALID',
            detail: 'cached game-asset password rejected',
          })
          return
        }
        this.setState('error', 'PASSWORD_INVALID', 'manual password rejected by decrypt', {
          code: 'PASSWORD_INVALID',
          detail: 'manual password invalid',
        })
        return
      }
      this.setState('error', err.code, err.detail, { code: err.code, detail: err.detail })
      return
    }
  }

  /**
   * Stat -> read -> re-stat, verifying stability and encrypted-payload block constraints.
   * Returns null when the file looks torn/mid-write. Never decodes; throws typed fs errors
   * upward (handled by the caller's stat/read error paths or the internal-error net).
   */
  private async readStableSave(path: string): Promise<StableRead | null> {
    const before = await this.statFile(path)
    const bytes = await this.readFile(path)
    const after = await this.statFile(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null
    const payloadLength = bytes.length - ES3_IV_LENGTH
    if (bytes.length < ES3_IV_LENGTH + 16 || payloadLength % 16 !== 0) return null
    return {
      bytes,
      mtimeMs: after.mtimeMs,
      size: after.size,
      signature: `${after.mtimeMs}:${after.size}`,
    }
  }

  /** Bounded re-read retries: sleep, then RE-STAT/RE-READ the file (fresh bytes each time). */
  private async readStableWithRetries(path: string): Promise<StableRead | null> {
    for (let attempt = 0; attempt <= this.midWriteRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.midWriteRetryDelayMs)
      const stable = await this.readStableSave(path)
      if (stable) return stable
    }
    return null
  }

  private discoverInstall(): string | null {
    const install = discoverGameInstall(this.customGamePath)
    return install ? install.path : null
  }

  /**
   * Freshness by the checkpoint's SOURCE timestamp (observedAtMs = lastSavedTime, with the
   * documented fileMtime fallback) — never by read/poll time. Also recovers a transient
   * 'degraded' state back to healthy/stale when the file is unchanged since the last good
   * decode (the transient condition has cleared).
   */
  private evaluateFreshness(): void {
    if (this.state === 'error' || this.state === 'disconnected') return
    const checkpoint = this.lastGoodCheckpoint
    if (!checkpoint) return
    const ageMs = this.now() - checkpoint.observedAtMs
    if (ageMs > this.staleAfterMs) {
      if (this.state !== 'stale') {
        this.setState('stale', 'STALE_CHECKPOINT', `checkpoint source time is ${Math.round(ageMs / 60_000)} min old`)
      }
      return
    }
    if (this.state !== 'healthy') {
      this.setState('healthy', 'SAVE_FOUND', null)
    }
  }
}
