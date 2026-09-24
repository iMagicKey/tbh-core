// Persistence wiring — composes the save source with the persistence layer.
//
// Framework-free (unit-testable without Electron). Guarantees:
//   * listeners are attached BEFORE the source starts, so the first checkpoint
//     and the first health transition are never missed;
//   * a persistence failure NEVER breaks the save source: writes are guarded,
//     the DatabaseManager is marked degraded, the source keeps running;
//   * the save source itself has no dependency on persistence classes.

import type { SaveCheckpointSource } from '../sources/save/SaveCheckpointSource'
import type { DatabaseStatsDto, DatabaseStatusDto } from '../shared/database'
import type { DatabaseManager } from './DatabaseManager'
import { CheckpointRepository } from './repositories/CheckpointRepository'
import { RunRepository } from './repositories/RunRepository'
import { SessionRepository } from './repositories/SessionRepository'
import { BuildRepository } from './repositories/BuildRepository'
import { SourceHealthRepository } from './repositories/SourceHealthRepository'

export class PersistenceWiring {
  private readonly checkpoints: CheckpointRepository | null
  private readonly health: SourceHealthRepository | null
  private readonly sessions: SessionRepository | null
  private readonly runs: RunRepository | null
  private readonly builds: BuildRepository | null
  private lastWriteAt: number | null = null
  private unsubscribeCheckpoint: (() => void) | null = null
  private unsubscribeHealth: (() => void) | null = null

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
        checkpoints.insertCheckpoint(checkpoint, Date.now())
        this.lastWriteAt = Date.now()
        this.dbManager.markHealthy()
      } catch (error) {
        // persistence degraded — the SAVE source itself stays untouched
        this.dbManager.markDegraded(error)
      }
    })
    this.unsubscribeHealth = source.onHealthChange((status) => {
      try {
        health.recordSaveSourceTransition(status, Date.now())
      } catch (error) {
        this.dbManager.markDegraded(error)
      }
    })
  }

  detach(): void {
    this.unsubscribeCheckpoint?.()
    this.unsubscribeHealth?.()
    this.unsubscribeCheckpoint = null
    this.unsubscribeHealth = null
  }

  /** Detach listeners and close the database (app shutdown). */
  close(): void {
    this.detach()
    this.dbManager.close()
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

  getStats(): DatabaseStatsDto {
    const empty: DatabaseStatsDto = {
      checkpointCount: 0,
      healthEventCount: 0,
      runCount: 0,
      sessionCount: 0,
      buildCount: 0,
    }
    try {
      if (!this.checkpoints || !this.health || !this.runs || !this.sessions || !this.builds) return empty
      return {
        checkpointCount: this.checkpoints.count(),
        healthEventCount: this.health.count(),
        runCount: this.runs.count(),
        sessionCount: this.sessions.count(),
        buildCount: this.builds.count(),
      }
    } catch {
      return empty
    }
  }

  private sanitize(detail: string): string {
    return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
  }
}
