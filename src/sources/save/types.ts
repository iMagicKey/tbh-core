// Internal (main-process) contracts of the save checkpoint source.
// Serializable output types live in src/shared/save-source.ts and must stay renderer-safe.

/**
 * One normalized save checkpoint: the persistent game state contained in the latest valid
 * SaveFile_Live.es3 decode.
 *
 * This is a CHECKPOINT, not per-run telemetry (Phase A data rules): it answers
 * "what persistent state did the latest save contain?", never "what happened in this run".
 */
export interface SaveCheckpoint {
  /** Source-truth time of the save (lastSavedTime ticks converted); fileMtime fallback. */
  observedAtMs: number
  observedTimeSource: 'lastSavedTime' | 'fileMtime'
  fileMtimeMs: number
  polledAtMs: number
  sourcePath: string

  saveVersion: string | null

  // common
  lastSavedTimeMs: number | null
  playTimeSeconds: number | null
  currentStageKey: number | null
  currentStageWave: number | null
  maxCompletedStage: number | null

  // party
  arrangedHeroKeys: number[]
  arrangedPetKey: number | null

  // currencies
  currencies: Array<{ key: number; quantity: number }>
  /** CurrencySaveData with Key == 100001 (gold wallet). null = absent/malformed, never 0-by-failure. */
  walletGold: number | null

  // heroes (save roster; deployed party is the memory source's job, not ours)
  heroes: SaveHero[]

  // items referenced by heroes/inventory/stash slots
  items: SaveItem[]

  // invested skill-tree nodes (attributeSaveDatas: key = heroKey*1000 + node)
  skillTree: Array<{ key: number; level: number }>

  // account-wide runes
  runes: Array<{ key: number; level: number }>

  // cumulative aggregates (EAggregateType; last-wins merge on duplicate type+subKey)
  aggregates: {
    raw: Array<{ type: number; subKey: number; value: number }>
    /** Type=2 (GoldEarn), SubKey=1 (COMBAT). null = absent, never 0-by-failure. */
    combatGoldEarned: number | null
    /** Type=13 (StageClear), SubKey=0. */
    stageClears: number | null
    /** Type=14 (StageFail), SubKey=0. */
    stageFails: number | null
  }

  // owned boxes (parallel arrays) — enough for future drop reconciliation
  boxes: SaveBoxes | null
}

export interface SaveHero {
  heroKey: number | null
  level: number | null
  withinLevelXp: number | null
  unlocked: boolean | null
  /** Exact 64-bit uniqueIds as strings (precision-preserving). */
  equippedItemIds: string[]
  equippedSkillKeys: number[]
}

export interface SaveItem {
  /** Exact 64-bit id as a string. */
  uniqueId: string
  itemKey: number | null
  /** 1.2.8+ field; string id preserved exactly when numeric. */
  registerId: string | null
  enchants: Array<{
    statType: number | null
    statModKey: number | null
    tier: number | null
    value: number | null
    recipeType: number | null
    modType: number | null
  }>
}

export interface SaveBoxes {
  boxTypes: number[]
  boxUniqueIds: string[]
  boxQuantities: number[]
}

/** Where a password came from. The value itself never enters status objects. */
export interface PasswordResolution {
  password: string
  provenance: 'manual' | 'game_asset'
  /** Basename of the asset file the password was extracted from (diagnostics only). */
  assetFile: string | null
}
