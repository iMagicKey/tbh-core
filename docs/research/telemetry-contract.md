# Phase A research — telemetry contract: source priority, reconciliation, proposed types

Covers: XP audit, Gold audit, the MVP source-priority matrix, reconciliation rules, and
documentation-level TypeScript contracts. All hierarchies below are grounded in the evidence in
`memory-source.md`, `save-source.md`, and `run-lifecycle.md`.

## 1. XP audit — every known measurement method

| # | Method | Used by | Accuracy | Latency | Level-up behavior | Multi-hero behavior | Save-lag behavior | Version sensitivity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| X1 | Live per-hero within-level exp (ACTk-decoded `HeroRuntime` ObscuredDouble), integrated tick-by-tick by an accumulator; level-ups bridged via the level curve | tbh-meter (primary) | exact (oracle-validated) | ~1 s | bridged by curve (`per_hero_gain`/`xp_through_levelup`, validated diff 0 across level-ups) | per-hero keyed by heroKey; late deploy seeded at first sighting; death banks 0 (real) | none (live read) | **high** — cipher encoding changed 1.00.20, width 1.00.27, struct moves with Unit base; live oracle required per build |
| X2 | Save per-hero `HeroExp` delta (in-memory save snapshot) | tbh-meter (fallback) | undercount on level-up (HeroExp resets) | jump-lagged | loses the level-up increment; at cap never resets = phantom (suppressed by `level_capped`) | per-hero | 0 or ~2× depending on write placement | medium (field widened 1.00.27; offsets shift often) |
| X3 | Save-file per-hero `HeroExp`+`HeroLevel` deltas | TBH-Optimizer, tbh-companion | window-level only (save quantization); TBH-Optimizer discards level-up windows outright | 1–3 min | tbh-companion counts max(cur,0) as accrual (approximation); TBH-Optimizer discards the window | per-hero available | IS the save — the quantization problem itself | low-medium (JSON keys stable) |
| X4 | Cumulative party XP reconstruction: `Σ (curve[level−1] + HeroExp)` over arranged party, rate-of over save samples | tbh-copilot | monotone total (survives level-up resets); wallet-grade (window, not run) | save cadence | handled by construction (cumulative) | sums the arranged party (save roster ≠ deployed party) | save cadence | low |
| X5 | Live in-process cumulative `HeroExp` accessor (value-matched resolution) baseline→end delta | TBH-DPS-dashboard | cumulative → no level-up loss | run boundary | none needed | per-hero via attacker attribution context | none (live) | high (accessor re-obfuscated every update; resolved by value-match vs save) |
| X6 | Estimated stage XP (wiki expectedEXP × retention model) | TBH-Optimizer, tbh-copilot, TBH-DPS (planner) | model, not measurement — used only where measured data is absent and always labeled `Est.`/projected | n/a | n/a | n/a | n/a | data-refresh burden |

### TBH Core source hierarchy (RECOMMENDATION)

**RUN XP**
1. MEMORY X1 (accumulator) — exact while reader healthy (`xp_source = live`);
2. MEMORY X2 (in-memory save snapshot per-hero delta) — fallback within the run, tagged
   (`xp_source = save`), level-up/cap rules as in tbh-meter;
3. SAVE-file X3 — **validation only** (never a run value);
4. no estimate fallback. Estimated stage XP (X6) is a separate, visibly-labeled feature — never a
   transparent substitute.

**SESSION XP** = Σ of valid RUN XP (memory) — checkpoint deltas (X3/X4) only as a displayed
cross-check with `checkpoint` confidence.

**PLAYER CURRENT XP (per hero)** = MEMORY X1 snapshot (level + within-level exp);
fallback SAVE X4-style cumulative reconstruction for display when memory is off (labeled).

## 2. Gold audit — every known source

| # | Source | Used by | Notes |
| --- | --- | --- | --- |
| G1 | **Cumulative combat gold**: `AggregateManager.AGGREGATES[GoldEarn=2][SubKey=1]` (live, memory) | tbh-meter (primary) | The cumulative combat aggregate **does exist** and is the correct per-run source. SubKeys: 0 = TOTAL rollup (combat+sale+idle+quest — do NOT use), 1 = COMBAT, 2/3 = standalone sale/idle/quest noise. Selling lands in TOTAL+wallet but NOT in COMBAT (validated live: sale 186,480 → total−combat exactly that, combat clean). |
| G2 | Same number, save side: `PlayerSaveData.AGGREGATES` (in-memory snapshot) / file-side `aggregateSaveDatas[Type=2,SubKey=1]` | tbh-meter (fallback), available to any save-based tool | Updates in ~100 s jumps → per-run delta is 0 or ~2× (live-measured: off +25 k / +1.18 M in two runs). |
| G3 | Wallet gold: `currenySaveDatas[Key=100001].Quantity` | everyone save-based; tbh-meter reads it only for PSD picking/display | Includes sales/idle/quest and purchases → **unsafe for per-run statistics**; TBH-Optimizer needed spend-recovery heuristics (rune-cost add-back) and spike filters; TBH-DPS documented "most rounds delta=0, one round gets the lump" and aggregates Σ(gold/sec×duration)/Σ(duration) to un-quantize. |
| G4 | Idle rewards / item sales / quest gold | distinguishable only via SubKeys 2/3 and TOTAL−COMBAT | The reason G3 is unsafe and G1/G2 are scoped to SubKey 1. |
| G5 | Modeled stage gold (wiki expectedGold × multipliers) | planners | estimate-labeled only. |

### Why wallet delta is unsafe for per-run stats (FACT summary)

A run's wallet delta conflates combat gains with concurrent sales/idle/quest income and with
purchases (negative), and the save flush quantizes even the honest part. tbh-meter's history
(the `gold:0` bug, the 1.97 T garbage-scan bug, sale-counting) and TBH-Optimizer's entire
anti-distortion stack exist because of wallet/total misuse. The fixed rule: **per-run gold = Δ of
cumulative combat (SubKey 1) only.**

### TBH Core source hierarchy (RECOMMENDATION)

**RUN GOLD**
1. MEMORY G1 (live cumulative combat, delta via monotonic `run_gain`) — `gold_source = live`;
2. MEMORY/SAVE G2 (save-side cumulative combat) — fallback, tagged `save`;
3. never wallet delta (G3); no estimate fallback.

**SESSION COMBAT GOLD** = Σ of valid RUN GOLD; cross-checked against G2 cumulative delta over the
session window (reconciliation, §3).

**PLAYER WALLET GOLD** = SAVE G3 (display value; high reliability as a value).

## 3. Source priority matrix (MVP)

Values: MEMORY / SAVE / PLAYER_LOG / DERIVED / NONE. "Validation" runs at persistence/reconcile
time, never replaces the primary in-flight value.

| Metric | Primary source | Validation source | Fallback | Notes |
| --- | --- | --- | --- | --- |
| Current stage | MEMORY (catalog-gated live chain) | SAVE currentStageKey | SAVE snapshot (tagged, ≤1 autosave lag) | 1.2.8: live monster field dead — the chain itself is the fix |
| Difficulty | MEMORY (stage catalog lookup) | SAVE (key decoding) | NONE | `difficulty*1000 + act*100 + stage` codec |
| Run start | MEMORY (implicit at previous close + baselines) | — | NONE (late attach → `partial-capture` label) | identity = end timestamp ms |
| Run end | MEMORY (LogManager event) | SAVE total-clears aggregate (windowed) | NONE | |
| Outcome | MEMORY (StageClearLog/StageFailedLog; abandon detector) | SAVE (inferred, weak) | NONE | save cannot distinguish outcomes |
| Duration | MEMORY (baselines→event; official `CLEAR_TIME` when success) | measured vs official ±20 % sanity | NONE | partial rule uses 95 % capture |
| XP/run | MEMORY X1 | SAVE X3 per-hero cumulative | MEMORY X2 (tagged save) | no estimate fallback |
| Gold/run | MEMORY G1 | SAVE G2 cumulative | MEMORY/SAVE G2 (tagged save) | never wallet |
| DPS | MEMORY (derived from HP-drop polling) | — | NONE | derived, but measured-derived |
| Damage | MEMORY (accumulated HP drops + killing blows) | — | NONE | |
| Mobs | MEMORY (alive-count deltas; total from catalog waves×mobs+1) | — | NONE | |
| Hero levels (live) | MEMORY X1 snapshot | SAVE HeroLevel (oracle ±1) | SAVE | |
| Party | MEMORY StageManager.HERO_LIST (catalog-gated) | SAVE arrangedHeroKey (context only) | NONE (degrade: heroes=err, run sealed) | never the roster as party |
| Equipment | MEMORY→save structures at close (items via uid→ItemSaveData) | SAVE file snapshot | NONE | uid 2^53 trap |
| Current gold (wallet) | SAVE G3 | — | NONE | display value |
| Current hero XP | MEMORY X1 | SAVE X4 cumulative | SAVE X4 (labeled) | |
| Game version | MEMORY (Version.txt + PE fingerprint) | SAVE commonSaveData.version | NONE | fingerprint gates the whole memory layout |
| Chest drops | MEMORY (GetBoxLog event, pending-close routing) | SAVE BoxData aggregates; PLAYER_LOG count-increase | PLAYER_LOG (supplementary) | 12 s cross-source dedup |

## 4. Reconciliation rules (RECOMMENDATION)

Worked examples from the brief:

- `Memory XP = 100,000,000` vs `Save checkpoint delta = 99,998,500` → **consistent**: the gap
  (0.15 %) is inside flush-lag noise; memory value stands, confidence stays `exact`/`measured`.
- `Memory XP = 100,000,000` vs `Save checkpoint delta = 63,000,000` → **conflict**: the save
  cumulative cannot lose 37 % to lag alone. Steps: (1) check window alignment (save
  `lastSavedTime`/`playTime` vs run window — is the checkpoint actually newer than run start?);
  (2) check other heroes' reconstruction and the level oracle (decoded level == save level);
  (3) if alignment is right and the oracle disagrees → memory reader health is suspect →
  DEMOTE the memory source (re-run health battery), mark affected runs `conflicted`.

Definitions:

- **Tolerance concepts**: for cumulative counters (gold/XP), compare *deltas over aligned
  windows*, not instantaneous values. Two tolerance families, both to be **empirically
  calibrated** in Phase B/E with real captures (no defensible fixed percentage exists yet in the
  evidence): flush-lag tolerance (small, ~the max gain between save writes — bounded by observed
  autosave cadence ~1–3 min) and structural tolerance (oracle checks: level equality ±1).
- **Timestamp windows**: anchor every save checkpoint to `lastSavedTime` (or mtime), never to
  poll time; a checkpoint validates only runs whose window it covers (newer-than-run-start, and
  compare same-window deltas).
- **Stale data**: a save checkpoint older than N× the observed cadence (or with unchanged
  `playTime`) is `stale` — display, don't reconcile.
- **Conflict states**: `consistent` (within calibrated tolerance) / `inconclusive` (window
  misaligned or checkpoint stale) / `conflict` (aligned, fresh, beyond tolerance) — persisted on
  the run record.
- **Missing sources**: absence of a validation source never invalidates a healthy primary; it
  only caps confidence at `measured` (no `verified` upgrade).
- **Confidence upgrades/downgrades**: `measured` → `verified` when a fresh aligned checkpoint is
  consistent; → `conflicted` on conflict; → `checkpoint`/`supplementary` for save/log-only
  values; `estimated` only for explicitly-labeled model features.
- **Exclusion from recommendations**: a run is excluded from farm analytics if it is `partial`,
  `degraded` in the metric being aggregated (gold/xp err), `conflicted` and unresolved, or its
  memory-source fingerprint/health epoch differs from the current trusted one.

## 5. Proposed data contracts (documentation-level TypeScript)

Design notes: `Observation` wraps every measured value with provenance; the ok/err envelope idea
comes from tbh-meter's `Field<T>` (never conflate didn't-read with read-zero). Kept deliberately
small — MVP needs, not a framework.

```ts
// --- provenance -------------------------------------------------------------
export type DataSourceKind = "memory" | "save" | "player_log" | "derived";
// metric-source sub-provenance within memory (mirrors tbh-meter's *_source tags)
export type MetricProvenance = "live" | "save" | "checkpoint" | "event";

export type ConfidenceLevel =
  | "exact"        // direct measured value, source healthy (e.g. live cumulative combat gold)
  | "measured"     // measured but unvalidated by a second source
  | "verified"     // measured + reconciled against an independent source
  | "checkpoint"   // save-snapshot value (correct at its timestamp, lagged)
  | "derived"      // computed from measured values (DPS, rates)
  | "estimated"    // model output — MUST be visibly labeled, never mixed with measured
  | "conflict"     | "unavailable";

export type SourceHealth =
  | "disconnected" | "detecting" | "healthy" | "degraded" | "unsupported_game_version"
  | "calibration_failed";   // entry/exit conditions: memory-source.md §4

// --- observations -----------------------------------------------------------
export interface Observation<T> {
  value: T;                       // undefined/null only when status = unavailable
  source: DataSourceKind;
  provenance?: MetricProvenance;
  observedAt: number;             // epoch ms of the SOURCE's truth (save: lastSavedTime/mtime)
  confidence: ConfidenceLevel;
  degradedReason?: string;        // e.g. "gold fell back to save", "stage from snapshot"
}

export interface Field<T> {       // ok/err envelope (tbh-meter pattern)
  ok: true;  value: T;
} | {
  ok: false; error: string;       // "didn't read" ≠ "read zero"
}

// --- compatibility ----------------------------------------------------------
export interface GameCompatibility {
  processPid?: number;
  gameVersion: string;            // Version.txt
  buildFingerprint?: string;      // "<version>-<tds>-<sizeofimage>" — keys the whole layout
  health: SourceHealth;
  healthDetail?: string;
  checkedAt: number;
}

// --- run lifecycle ----------------------------------------------------------
export type RunLifecycleEventKind =
  | "run_start" | "run_clear" | "run_fail" | "run_abandon"
  | "stage_change" | "reader_attach" | "reader_detach";

export interface RunLifecycleEvent {
  kind: RunLifecycleEventKind;
  runId?: string;                 // end-timestamp id once known
  stageKey?: number;
  observedAt: number;
  source: DataSourceKind;
  detail?: Record<string, unknown>; // e.g. clearTime, waves, deadCountDrop
}

// --- completed run ----------------------------------------------------------
export interface HeroRunEntry {
  heroKey: number;
  level?: number;
  xpGained: Field<number>;
  deaths?: number; revives?: number;
  slot?: number;                  // formation position 0..2
}

export interface CompletedRun {
  id: string;                     // end timestamp ms (identity — never a counter)
  startedAt: number; endedAt: number;
  outcome: "success" | "fail" | "abandoned";
  stage: Field<{ key: number; act: number; stageNo: number; difficulty: number }>;
  durationMs: number;
  officialClearTimeS?: number;
  clearQuality: "complete" | "partial";     // partial-capture flag
  xp: Observation<number> & { perHero?: HeroRunEntry[] };
  gold: Observation<number>;                // combat gold only (SubKey 1)
  damage?: number; mobsKilled?: number; mobsTotal?: number;
  drops: Field<Array<{ boxTier: 0 | 1 | 2 }>>;
  party: Field<HeroRunEntry[]>;
  buildFingerprintId?: string;     // link into build epochs (farm-analytics.md)
  gameVersion: string; buildFingerprint?: string;
  sourceHealthEpoch?: string;      // reader health epoch at capture time
  reconciliation?: RunReconciliation;
}

// --- reconciliation ---------------------------------------------------------
export interface RunReconciliation {
  status: "consistent" | "inconclusive" | "conflict";
  checks: Array<{
    metric: "xp" | "gold" | "runCount" | "drops";
    primary: number; checkpoint?: number;
    windowFrom: number; windowTo: number;   // anchored to save lastSavedTime
    verdict: "consistent" | "inconclusive" | "conflict";
  }>;
  resolvedAt?: number;
}

export interface TelemetryConflict {       // surfaced to UI / diagnostics
  metric: string;
  memory?: number; save?: number; playerLog?: number;
  window: { from: number; to: number };
  severity: "info" | "warning" | "error";
  resolution: "memory_wins" | "pending" | "excluded";
}

// --- build fingerprint ------------------------------------------------------
export interface BuildFingerprint {
  id: string;                     // short stable hash, internal
  partyHeroKeys: number[];        // MUST
  heroLevels: Record<number, number>;       // MUST
  equippedItems: Record<number, Array<{ itemKey: number; enchantSummary: string }>>; // MUST
  equippedSkills: Record<number, number[]>; // SHOULD
  skillTreeSummary?: Record<number, number>; // SHOULD (invested levels)
  runes?: Array<{ key: number; level: number }>;             // SHOULD (account-wide)
  petKey?: number | null;                                       // LATER
  createdAt: number; replacedBy?: string;
}
```

Versioning rule (from tbh-meter's schema-versioning invariant): persist a `schema_version`
alongside stored runs; additive optional fields don't bump it; shape changes do. Run ids are
end-timestamp strings — collision-free across restarts by construction.
