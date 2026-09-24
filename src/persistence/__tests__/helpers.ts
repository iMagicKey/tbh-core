// Shared persistence test helpers — synthetic SaveCheckpoints and temp databases.

import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../migrations'
import type { SaveCheckpoint } from '../../sources/save/types'

export function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'tbh-persist-')), 'test.sqlite3')
}

export function makeCheckpoint(overrides: Partial<SaveCheckpoint> = {}): SaveCheckpoint {
  return {
    observedAtMs: 1_760_000_000_000,
    observedTimeSource: 'lastSavedTime',
    fileMtimeMs: 1_760_000_001_000,
    polledAtMs: 1_760_000_002_000,
    sourcePath: 'X:\\synthetic\\SaveFile_Live.es3',
    saveVersion: '1.2.8',
    lastSavedTimeMs: 1_760_000_000_000,
    playTimeSeconds: 66_271.95,
    currentStageKey: 2205,
    currentStageWave: 3,
    maxCompletedStage: 2303,
    arrangedHeroKeys: [401, 301, 201],
    arrangedPetKey: null,
    currencies: [{ key: 100001, quantity: 3_667_610 }],
    walletGold: 3_667_610,
    heroes: [
      {
        heroKey: 201,
        level: 37,
        withinLevelXp: 21_540_000,
        unlocked: true,
        equippedItemIds: ['9007199254740993', '18446744073709551615'],
        equippedSkillKeys: [1101, 1102],
      },
      { heroKey: 301, level: 37, withinLevelXp: null, unlocked: null, equippedItemIds: [], equippedSkillKeys: [] },
    ],
    items: [],
    skillTree: [{ key: 201003, level: 4 }],
    runes: [{ key: 110011, level: 3 }],
    aggregates: {
      raw: [{ type: 2, subKey: 1, value: 13_443_611 }],
      combatGoldEarned: 13_443_611,
      stageClears: 310,
      stageFails: 8,
    },
    boxes: {
      entries: [
        { type: 1, uniqueId: '18446744073709551615', quantity: 2 },
        { type: null, uniqueId: null, quantity: null },
      ],
    },
    ...overrides,
  }
}

/** Open a throwaway in-memory database with migrations applied (repo-level tests). */
export function migratedMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  runMigrations(db)
  return db
}
