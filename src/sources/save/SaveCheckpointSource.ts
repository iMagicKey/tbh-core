// SaveCheckpointSource — read-only polling source for SaveFile_Live.es3.
//
// Responsibilities (and nothing else):
//   * resolve the save path (custom override or default);
//   * resolve the ES3 password (manual env override or game-asset extraction);
//   * poll file metadata; decode ONLY when mtime/size changed (atomic replacement aware:
//     we never hold the file open; re-stat after read catches in-flight replacements);
//   * classify failures (MID_WRITE transient, password/parse permanent-ish) with typed codes;
//   * retain the last known-good checkpoint across transient failures;
//   * expose state/health and a narrow subscription API.
//
// NOT its job: per-run telemetry (memory source), reconciliation, analytics.
// The file is only ever READ — never written, renamed, replaced, or truncated by us.

import { readFile, stat } from 'node:fs/promises'
import type { SaveSourceStatus } from '../../shared/save-source'
import { decodeEs3File } from './es3'
import { SaveSourceError } from './errors'
import { discoverGameInstall, gameDataDir, resolveSavePath } from './discovery'
import { normalizeCheckpoint } from './normalize'
import { resolveEs3Password } from './password'
import type { PasswordResolution, SaveCheckpoint } from './types'

export const SAVE_POLL_INTERVAL_MS = 5_000 // Phase A evidence: save cadence ~1-3 min; 5s poll is comfortable
export const STALE_AFTER_MS = 10 * 60_000 // no NEW save decoded for this long -> stale
export const MID_WRITE_RETRIES = 3 // bounded in-tick retries for a block-misaligned read
export const MID_WRITE_RETRY_DELAY_MS = 150

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
}

type Listener<T> = (value: T) => void

export class SaveCheckpointSource {
  private readonly pollIntervalMs: number
  private readonly staleAfterMs: number
  private readonly midWriteRetries: number
  private readonly midWriteRetryDelayMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
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
      lastSuccessfulReadAt: this.lastSuccessfulReadAt,
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

  private setState(state: SaveSourceStatus['state'], reasonCode: SaveSourceStatus['reasonCode'], detail: string | null, error?: SaveSourceStatus['lastError']): void {
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
      const st = await stat(resolved.path)
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
      this.applyStaleness()
      return
    }

    // ---- read the file (transient failures keep last good; do not advance signature)
    let bytes: Buffer
    try {
      bytes = await readFile(resolved.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.setState('degraded', 'SAVE_UNREADABLE', `read failed (${code ?? 'unknown'})`, {
        code: 'SAVE_UNREADABLE',
        detail: String(code ?? 'unknown'),
      })
      return
    }
    // atomic-replacement guard: if the file changed size while we read it, we likely caught
    // the replace mid-flight — treat as transient mid-write, do not decode a torn buffer
    try {
      const after = await stat(resolved.path)
      if (after.size !== fileStat.size || after.mtimeMs !== fileStat.mtimeMs) {
        this.handleMidWrite('file replaced during read')
        return
      }
    } catch {
      this.handleMidWrite('re-stat failed')
      return
    }

    // ---- password (resolve lazily; re-resolved on refresh or after an invalid decrypt)
    if (!this.password) {
      this.gameInstallPath = this.discoverInstall()
      try {
        this.password = resolveEs3Password({
          manualPassword: this.manualPassword,
          gameInstallPath: this.gameInstallPath,
        })
      } catch (error) {
        const err = error as SaveSourceError
        this.setState('error', err.code, err.detail, { code: err.code, detail: err.detail })
        return
      }
    }

    // ---- decode with bounded mid-write retries
    for (let attempt = 0; attempt <= this.midWriteRetries; attempt++) {
      try {
        const decoded = decodeEs3File(bytes, this.password.password)
        const checkpoint = normalizeCheckpoint(decoded.inner, {
          fileMtimeMs: fileStat.mtimeMs,
          polledAtMs: this.lastAttemptAt,
          sourcePath: resolved.path,
        })
        this.lastGoodCheckpoint = checkpoint
        this.lastSuccessfulReadAt = this.now()
        this.lastDecodedSignature = signature
        this.lastError = null
        this.setState('healthy', 'SAVE_FOUND', resolved.origin === 'custom' ? 'custom save path' : null)
        for (const listener of this.checkpointListeners) listener(checkpoint)
        return
      } catch (error) {
        const err = error instanceof SaveSourceError ? error : new SaveSourceError('DECRYPT_FAILED', String(error))
        if (err.code === 'MID_WRITE') {
          if (attempt < this.midWriteRetries) {
            await this.sleep(this.midWriteRetryDelayMs)
            continue
          }
          this.handleMidWrite(err.detail) // transient: next poll retries (signature not advanced)
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
  }

  private discoverInstall(): string | null {
    const install = discoverGameInstall(this.customGamePath)
    return install ? install.path : null
  }

  private handleMidWrite(detail: string | null): void {
    // transient: keep last good checkpoint, keep lastDecodedSignature unchanged so the next
    // poll retries the read; bounded by poll interval (no busy loop)
    this.setState('degraded', 'MID_WRITE', detail, { code: 'MID_WRITE', detail })
  }

  private applyStaleness(): void {
    if (this.state !== 'healthy' && this.state !== 'stale') return
    const lastChange = Math.max(this.lastSuccessfulReadAt ?? 0, this.lastGoodCheckpoint?.fileMtimeMs ?? 0)
    const idleFor = this.now() - lastChange
    if (idleFor > this.staleAfterMs) {
      this.setState('stale', 'STALE_CHECKPOINT', `no new save for ${Math.round(idleFor / 60_000)} min`)
    } else if (this.state === 'stale') {
      this.setState('healthy', 'SAVE_FOUND', null)
    }
  }
}
