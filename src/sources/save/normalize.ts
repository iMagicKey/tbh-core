// Save normalization: turn the decoded inner save JSON into a SaveCheckpoint.
//
// The save schema is game-controlled: unknown keys are ignored, additive fields tolerated,
// numeric fields may arrive as number OR numeric string (Phase A: HeroExp, playTime), and
// parse failures surface as `null` — NEVER as a silent 0.

import type { SaveBoxes, SaveCheckpoint, SaveHero, SaveItem } from './types'

// .NET ticks (100ns since 0001-01-01) -> unix ms
const TICKS_TO_MS_DIVIDEND = 10_000 // 100ns units per ms
const DOTNET_EPOCH_OFFSET_MS = 62_135_596_800_000 // unix ms at 0001-01-01
// sanity window for accepted timestamps (rejects garbage ticks without failing the parse)
const MIN_SANE_MS = Date.UTC(2020, 0, 1)
const MAX_SANE_MS = Date.UTC(2100, 0, 1)

const GOLD_CURRENCY_KEY = 100001
const AGG_GOLD_EARN = 2
const AGG_STAGE_CLEAR = 13
const AGG_STAGE_FAIL = 14
const COMBAT_GOLD_SUBKEY = 1

/** number | numeric string -> number. Comma-decimal strings tolerated (observed on HeroExp). */
export function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const normalized = /^[+-]?\d+,\d+$/.test(value.trim()) ? value.trim().replace(',', '.') : value.trim()
    if (normalized.length === 0 || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(normalized)) return undefined
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** number | numeric string -> safe integer. */
export function parseInteger(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Exact integral identity: number | numeric string -> string (precision-preserving). */
export function parseIntegralString(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : undefined
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return value.trim()
  }
  return undefined
}

/** .NET ticks (number or numeric string; large values arrive as strings via json-safe) -> unix ms. */
export function parseDotNetTicks(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value)
  if (parsed === undefined || parsed <= 0) return undefined
  const ms = Math.round(parsed / TICKS_TO_MS_DIVIDEND) - DOTNET_EPOCH_OFFSET_MS
  if (ms < MIN_SANE_MS || ms > MAX_SANE_MS) return undefined
  return ms
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false
  return null
}

function normalizeHeroes(value: unknown): SaveHero[] {
  const out: SaveHero[] = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    if (!record) continue
    out.push({
      heroKey: parseInteger(record['heroKey']) ?? null,
      level: parseInteger(record['HeroLevel']) ?? null,
      withinLevelXp: parseFiniteNumber(record['HeroExp']) ?? null,
      unlocked: parseBoolean(record['IsUnLock'] ?? record['IsUnlock']) ?? null,
      equippedItemIds: asArray(record['equippedItemIds'])
        .map((id) => parseIntegralString(id))
        .filter((id): id is string => id !== undefined),
      equippedSkillKeys: asArray(record['equippedSKillKey'])
        .map((key) => parseInteger(key))
        .filter((key): key is number => key !== undefined),
    })
  }
  return out
}

function normalizeItems(value: unknown): SaveItem[] {
  const out: SaveItem[] = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const uniqueId = parseIntegralString(record['UniqueId'])
    if (uniqueId === undefined) continue // an item without an exact id cannot be referenced
    const enchants = asArray(record['EnchantData']).flatMap((raw) => {
      const e = asRecord(raw)
      if (!e) return []
      return [
        {
          statType: parseInteger(e['StatType']) ?? null,
          statModKey: parseInteger(e['StatModKey']) ?? null,
          tier: parseInteger(e['Tier']) ?? null,
          value: parseFiniteNumber(e['Value']) ?? null,
          recipeType: parseInteger(e['RecipeType']) ?? null,
          modType: parseInteger(e['ModType']) ?? null,
        },
      ]
    })
    out.push({
      uniqueId,
      itemKey: parseInteger(record['ItemKey']) ?? null,
      registerId: parseIntegralString(record['RegisterID'] ?? record['RegisterId']) ?? null,
      enchants,
    })
  }
  return out
}

function normalizeKeyLevels(value: unknown, keyField: string): Array<{ key: number; level: number }> {
  const out: Array<{ key: number; level: number }> = []
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const key = parseInteger(record[keyField] ?? record['Key'])
    const level = parseInteger(record['Level'])
    if (key === undefined || level === undefined) continue
    out.push({ key, level })
  }
  return out
}

function normalizeCurrencies(value: unknown): { list: Array<{ key: number; quantity: number }>; walletGold: number | null } {
  const list: Array<{ key: number; quantity: number }> = []
  let walletGold: number | null = null
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const key = parseInteger(record['Key'] ?? record['key'])
    const quantity = parseFiniteNumber(record['Quantity'] ?? record['quantity'])
    if (key === undefined || quantity === undefined) continue
    list.push({ key, quantity })
    if (key === GOLD_CURRENCY_KEY) walletGold = quantity
  }
  return { list, walletGold }
}

function normalizeAggregates(value: unknown): SaveCheckpoint['aggregates'] {
  const merged = new Map<string, { type: number; subKey: number; value: number }>()
  for (const entry of asArray(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const type = parseInteger(record['Type'])
    const subKey = parseInteger(record['SubKey'])
    const amount = parseFiniteNumber(record['Value'])
    if (type === undefined || subKey === undefined || amount === undefined) continue
    merged.set(`${type}:${subKey}`, { type, subKey, value: amount }) // last-wins on duplicates
  }
  const raw = [...merged.values()]
  const find = (type: number, subKey: number) => merged.get(`${type}:${subKey}`)?.value ?? null
  return {
    raw,
    combatGoldEarned: find(AGG_GOLD_EARN, COMBAT_GOLD_SUBKEY),
    stageClears: find(AGG_STAGE_CLEAR, 0),
    stageFails: find(AGG_STAGE_FAIL, 0),
  }
}

function normalizeBoxes(value: unknown): SaveCheckpoint['boxes'] {
  const record = asRecord(value)
  if (!record) return null
  // INDEX-ALIGNED parse: never compact parallel arrays independently — a malformed value in
  // one array must not shift positions and re-associate quantity/identity (future
  // Player.log reconciliation depends on slot identity).
  const types = asArray(record['BoxTypes']).map((v) => parseInteger(v) ?? null)
  const uniqueIds = asArray(record['BoxUniqueId'] ?? record['BoxUniqueIds']).map(
    (v) => parseIntegralString(v) ?? null,
  )
  const quantities = asArray(record['BoxQuantity'] ?? record['BoxQuantities']).map(
    (v) => parseInteger(v) ?? null,
  )
  const length = Math.max(types.length, uniqueIds.length, quantities.length)
  if (length === 0) return null
  const entries: SaveBoxes['entries'] = []
  for (let i = 0; i < length; i++) {
    entries.push({ type: types[i] ?? null, uniqueId: uniqueIds[i] ?? null, quantity: quantities[i] ?? null })
  }
  return { entries }
}

export interface NormalizeContext {
  fileMtimeMs: number
  polledAtMs: number
  sourcePath: string
}

/** Normalize a decoded inner save into a SaveCheckpoint. Unknown fields are ignored. */
export function normalizeCheckpoint(inner: Record<string, unknown>, ctx: NormalizeContext): SaveCheckpoint {
  const common = asRecord(inner['commonSaveData']) ?? {}
  const lastSavedTimeMs = parseDotNetTicks(common['lastSavedTime']) ?? null
  const currencies = normalizeCurrencies(inner['currenySaveDatas'] ?? inner['currencySaveDatas'])

  const arrangedPetKey = parseInteger(common['ArrangedPetKey']) ?? null

  return {
    // observed time: source truth when lastSavedTime is present and sane;
    // documented degraded fallback = file mtime (flagged, never silently poll time)
    observedAtMs: lastSavedTimeMs ?? ctx.fileMtimeMs,
    observedTimeSource: lastSavedTimeMs !== null ? 'lastSavedTime' : 'fileMtime',
    fileMtimeMs: ctx.fileMtimeMs,
    polledAtMs: ctx.polledAtMs,
    sourcePath: ctx.sourcePath,

    saveVersion: typeof common['version'] === 'string' && common['version'].length > 0 ? common['version'] : null,

    lastSavedTimeMs,
    playTimeSeconds: parseFiniteNumber(common['playTime']) ?? null,
    currentStageKey: parseInteger(common['currentStageKey']) ?? null,
    currentStageWave: parseInteger(common['currentStageWave']) ?? null,
    maxCompletedStage: parseInteger(common['maxCompletedStage']) ?? null,

    arrangedHeroKeys: asArray(common['arrangedHeroKey'])
      .map((v) => parseInteger(v))
      .filter((v): v is number => v !== undefined),
    arrangedPetKey,

    currencies: currencies.list,
    walletGold: currencies.walletGold,

    heroes: normalizeHeroes(inner['heroSaveDatas']),
    items: normalizeItems(inner['itemSaveDatas']),
    skillTree: normalizeKeyLevels(inner['attributeSaveDatas'], 'Key'),
    runes: normalizeKeyLevels(inner['RuneSaveData'] ?? inner['runeSaveDatas'], 'RuneKey'),
    aggregates: normalizeAggregates(inner['aggregateSaveDatas']),
    boxes: normalizeBoxes(inner['BoxData']),
  }
}
