// Persistence wiring — composes the save source with the persistence layer.
//
// Framework-free (unit-testable without Electron). Guarantees:
//   * listeners are attached BEFORE the source starts, so the first checkpoint
//     and the first health transition are never missed;
//   * a persistence failure NEVER breaks the save source: writes are guarded,
//     the DatabaseManager is marked degraded, the source keeps running;
//   * the save source itself has no dependency on persistence classes.

import type { SaveCheckpointSource } from '../sources/save/SaveCheckpointSource'
import type { MemorySource } from '../sources/memory/MemorySource'
import { toRunInput } from '../sources/memory/adapter'
import type { DatabaseStatsDto, DatabaseStatusDto } from '../shared/database'
import type { DatabaseManager } from './DatabaseManager'
import { CheckpointRepository } from './repositories/CheckpointRepository'
import { RunConflictError, RunRepository } from './repositories/RunRepository'
import { SessionRepository } from './repositories/SessionRepository'
import { BuildRepository } from './repositories/BuildRepository'
import { sanitizeDetail, SourceHealthRepository } from './repositories/SourceHealthRepository'

export class PersistenceWiring {
  private readonly checkpoints: CheckpointRepository | null
  private readonly health: SourceHealthRepository | null
  private readonly sessions: SessionRepository | null
  private readonly runs: RunRepository | null
  private readonly builds: BuildRepository | null
  private lastWriteAt: number | null = null
  private unsubscribeCheckpoint: (() => void) | null = null
  private unsubscribeHealth: (() => void) | null = null
  private unsubscribeRun: (() => void) | null = null
  private unsubscribeMemoryHealth: (() => void) | null = null

  constructor(private readonly dbManager: DatabaseManager) {
    const db = dbManager.getDatabase()
    this.checkpoints = db ? new CheckpointRepository(db) : null
    this.health = db ? new SourceHealthRepository(db) : null
    this.sessions = db ? new SessionRepository(db) : null
    this.runs = db ? new RunRepository(db) : null
    this.builds = db ? new BuildRepository(db) : null
  }

  /** Attach persistence listeners. MUST be called before source.start(). */
  attachTo(source: SaveCheckpointSource): void {
    const checkpoints = this.checkpoints
    const health = this.health
    if (!checkpoints || !health) return
    this.unsubscribeCheckpoint = source.onCheckpoint((checkpoint) => {
      try {
        const result = checkpoints.insertCheckpoint(checkpoint, Date.now())
        // "last persisted" means an ACTUAL successful mutation — a dedupe no-op
        // is not a database write
        if (result.inserted) this.lastWriteAt = Date.now()
        this.dbManager.markHealthy()
      } catch (error) {
        // persistence degraded — the SAVE source itself stays untouched
        this.dbManager.markDegraded(error)
      }
    })
    this.unsubscribeHealth = source.onHealthChange((status) => {
      try {
        const wrote = health.recordSaveSourceTransition(status, Date.now())
        if (wrote) this.lastWriteAt = Date.now() // same rule: real writes only
      } catch (error) {
        this.dbManager.markDegraded(error)
      }
    })
  }

  detach(): void {
    this.unsubscribeCheckpoint?.()
    this.unsubscribeHealth?.()
    this.unsubscribeRun?.()
    this.unsubscribeMemoryHealth?.()
    this.unsubscribeCheckpoint = null
    this.unsubscribeHealth = null
    this.unsubscribeRun = null
    this.unsubscribeMemoryHealth = null
  }

  /** Detach listeners and close the database (app shutdown). */
  close(): void {
    this.detach()
    this.dbManager.close()
  }

  /**
   * Wire the memory source to persistence: completed runs -> runs table,
   * health transitions -> source_health_events (source_kind='memory').
   * Same failure contract as the save source: persistence problems never stop
   * the source; a run-id conflict surfaces as a persistence diagnostic.
   */
  attachMemorySource(source: MemorySource): void {
    const runs = this.runs
    const health = this.health
    if (!runs || !health) return
    this.unsubscribeRun = source.onCompletedRun((run) => {
      try {
        const result = runs.insertRun(toRunInput(run, Date.now()))
        if (result.inserted) this.lastWriteAt = Date.now()
        this.dbManager.markHealthy()
      } catch (error) {
        if (error instanceof RunConflictError) {
          // typed conflict: surface as a persistence diagnostic, never overwrite
          this.dbManager.markDegraded(error)
        } else {
          this.dbManager.markDegraded(error)
        }
      }
    })
    this.unsubscribeMemoryHealth = source.onHealthChange((status) => {
      try {
        const wrote = health.recordTransition(
          'memory',
          {
            state: status.state,
            reasonCode: status.reasonCode,
            detail: sanitizeDetail(status.detail),
          },
          Date.now(),
        )
        if (wrote) this.lastWriteAt = Date.now()
      } catch (error) {
        this.dbManager.markDegraded(error)
      }
    })
  }

  getStatus(): DatabaseStatusDto {
    const status = this.dbManager.getStatus()
    return {
      state: status.state,
      schemaVersion: status.schemaVersion,
      databaseFilename: this.dbManager.filename,
      lastWriteAt: this.lastWriteAt,
      lastErrorCode: status.lastErrorCode,
      lastErrorDetail: status.lastErrorDetail ? this.sanitize(status.lastErrorDetail) : null,
    }
  }

  /**
   * Counts, or NULL when they cannot be queried (DB unavailable or broken).
   * Null is intentionally distinct from all-zero counts: "unavailable" must
   * never look like "healthy but empty". The DB STATUS stays the authoritative
   * error surface — stats expose no exception details.
   */
  getStats(): DatabaseStatsDto | null {
    try {
      if (!this.checkpoints || !this.health || !this.runs || !this.sessions || !this.builds) {
        return null
      }
      return {
        checkpointCount: this.checkpoints.count(),
        healthEventCount: this.health.count(),
        runCount: this.runs.count(),
        sessionCount: this.sessions.count(),
        buildCount: this.builds.count(),
      }
    } catch {
      return null
    }
  }

  private sanitize(detail: string): string {
    return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
  }
}
