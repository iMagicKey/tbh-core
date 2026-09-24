import { describe, expect, it } from 'vitest'
import { bigIntSafeJsonParse } from '../json-safe'
import { normalizeCheckpoint, parseDotNetTicks, parseFiniteNumber, parseInteger } from '../normalize'
import { BIG_ID_A, BIG_ID_B, KNOWN_TICKS, KNOWN_TICKS_MS, makeInnerSaveText } from './fixtures'

const CTX = { fileMtimeMs: 1_700_000_000_000, polledAtMs: 1_700_000_005_000, sourcePath: 'X:\\synthetic\\SaveFile_Live.es3' }

function parseInner(text: string): Record<string, unknown> {
  return bigIntSafeJsonParse(text) as Record<string, unknown>
}

describe('parse helpers', () => {
  it('parseFiniteNumber accepts numbers and numeric strings (incl. comma decimal)', () => {
    expect(parseFiniteNumber(12.5)).toBe(12.5)
    expect(parseFiniteNumber('1000.5')).toBe(1000.5)
    expect(parseFiniteNumber('22180000,5')).toBe(22180000.5)
    expect(parseFiniteNumber('abc')).toBeUndefined()
    expect(parseFiniteNumber(null)).toBeUndefined()
    expect(parseFiniteNumber(Number.NaN)).toBeUndefined()
  })

  it('parseInteger rejects non-safe integers', () => {
    expect(parseInteger('42')).toBe(42)
    expect(parseInteger('9007199254740993')).toBeUndefined() // beyond 2^53
    expect(parseInteger(3.5)).toBeUndefined()
  })

  it('parseDotNetTicks converts .NET ticks to unix ms', () => {
    expect(parseDotNetTicks(KNOWN_TICKS)).toBe(KNOWN_TICKS_MS)
    expect(parseDotNetTicks(Number(KNOWN_TICKS))).toBeCloseTo(KNOWN_TICKS_MS, 0)
    expect(parseDotNetTicks('garbage')).toBeUndefined()
    expect(parseDotNetTicks('1e30')).toBeUndefined() // outside sane window
    expect(parseDotNetTicks(-5)).toBeUndefined()
  })
})

describe('normalizeCheckpoint', () => {
  const checkpoint = normalizeCheckpoint(parseInner(makeInnerSaveText()), CTX)

  it('normalizes common fields with source-truth time', () => {
    expect(checkpoint.observedAtMs).toBe(KNOWN_TICKS_MS)
    expect(checkpoint.observedTimeSource).toBe('lastSavedTime')
    expect(checkpoint.saveVersion).toBe('1.2.8')
    expect(checkpoint.currentStageKey).toBe(2205)
    expect(checkpoint.currentStageWave).toBe(3)
    expect(checkpoint.maxCompletedStage).toBe(2210)
    expect(checkpoint.playTimeSeconds).toBe(1_234_567)
    expect(checkpoint.arrangedHeroKeys).toEqual([201, 301, 401])
  })

  it('falls back to fileMtime (flagged) when lastSavedTime is missing/malformed', () => {
    const inner = parseInner(makeInnerSaveText())
    ;(inner['commonSaveData'] as Record<string, unknown>)['lastSavedTime'] = 'garbage'
    const degraded = normalizeCheckpoint(inner, CTX)
    expect(degraded.observedTimeSource).toBe('fileMtime')
    expect(degraded.observedAtMs).toBe(CTX.fileMtimeMs)
    expect(degraded.lastSavedTimeMs).toBeNull()
  })

  it('normalizes wallet gold and other currencies without conflating absence with zero', () => {
    expect(checkpoint.walletGold).toBe(123_456)
    expect(checkpoint.currencies).toEqual([
      { key: 100001, quantity: 123_456 },
      { key: 200001, quantity: 42 },
    ])
    const inner = parseInner(makeInnerSaveText())
    delete inner['currenySaveDatas']
    expect(normalizeCheckpoint(inner, CTX).walletGold).toBeNull()
  })

  it('normalizes heroes: number/string values, bool forms, exact equipped ids', () => {
    expect(checkpoint.heroes).toHaveLength(2)
    const [heroA, heroB] = checkpoint.heroes
    expect(heroA.heroKey).toBe(201)
    expect(heroA.level).toBe(35)
    expect(heroA.withinLevelXp).toBe(2.154e7)
    expect(heroA.unlocked).toBe(true)
    expect(heroA.equippedItemIds).toEqual([BIG_ID_A, BIG_ID_B, '12345']) // exact 64-bit strings
    expect(heroA.equippedSkillKeys).toEqual([1101, 1102])
    // second hero: numeric-string level, comma-decimal exp, 1/0 unlock form
    expect(heroB.level).toBe(35)
    expect(heroB.withinLevelXp).toBe(22180000.5)
    expect(heroB.unlocked).toBe(true)
  })

  it('normalizes items with exact ids and enchant identity', () => {
    expect(checkpoint.items).toHaveLength(2)
    const [itemA] = checkpoint.items
    expect(itemA.uniqueId).toBe(BIG_ID_A)
    expect(itemA.itemKey).toBe(300001)
    expect(itemA.registerId).toBe(BIG_ID_B)
    expect(itemA.enchants).toEqual([
      { statType: 1, statModKey: 7, tier: 2, value: 12.5, recipeType: 3, modType: 0 },
    ])
  })

  it('normalizes skill tree, runes, aggregates (combat gold Type=2/SubKey=1)', () => {
    expect(checkpoint.skillTree).toEqual([
      { key: 201003, level: 4 },
      { key: 301014, level: 2 },
    ])
    expect(checkpoint.runes).toEqual([
      { key: 110011, level: 3 },
      { key: 15002, level: 1 },
    ])
    expect(checkpoint.aggregates.combatGoldEarned).toBe(11_934_046) // NOT the SubKey-0 rollup (20M)
    expect(checkpoint.aggregates.stageClears).toBe(87)
    expect(checkpoint.aggregates.stageFails).toBe(5)
  })

  it('normalizes BoxData parallel arrays with exact unique ids', () => {
    expect(checkpoint.boxes).toEqual({
      boxTypes: [1, 0],
      boxUniqueIds: [BIG_ID_B, BIG_ID_A],
      boxQuantities: [2, 9],
    })
  })

  it('ignores unknown additive fields at every level', () => {
    const extended = makeInnerSaveText({
      unknownTopLevel: '{"brandNewFeature":{"nested":[1,2,3]}}',
      heroExtra: '{"someNewHeroField":"whatever"}',
    })
    const normalized = normalizeCheckpoint(parseInner(extended), CTX)
    expect(normalized.currentStageKey).toBe(2205)
    expect(normalized.heroes[0].heroKey).toBe(201)
  })

  it('handles malformed required values explicitly (null, never silent 0)', () => {
    const inner = parseInner(
      makeInnerSaveText({ heroExtra: '{"heroKey":"not-a-number","HeroLevel":null}' }),
    )
    const [hero] = normalizeCheckpoint(inner, CTX).heroes
    expect(hero.heroKey).toBeNull()
    expect(hero.level).toBeNull()
  })
})
