# Phase A research — memory source audit

Primary evidence: local updated `D:\VSC\tbh-meter` (targets game build **1.2.8**, live-validated —
see `local-tbh-meter-audit.md`). All file references are repo-relative to `tbh-meter/reader/`
unless noted. FACT = read in source during this audit; INFERENCE = conclusion; RECOMMENDATION =
proposal for TBH Core.

## 1. Complete data flow of the tbh-meter memory reader

```text
TaskBarHero.exe  (PROCESS_NAME, offsets.py)
   │  find_pid(): CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS), match szExeFile  [shared/memory.py]
   ▼
OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)   ← the ONLY attach point, read-only
   │  process_image_path() → QueryFullProcessImageNameW → <gamedir>/Version.txt = installed version
   │  ga_module(pid): Toolhelp module snapshot → GameAssembly.dll base+size
   │  build_fingerprint = f"{version}-{TimeDateStamp:#x}-{SizeOfImage:#x}"  [il2cpp/typeinfo.py]
   ▼
Address/class resolution — two paths, gated by fingerprint (resolve_all, meter_windows.py)
   │  FAST (~ms, calib hit): calib[fp] {anchor_rva, indices{name:idx}, idx_ut}
   │     → tbase = [ga_base + anchor_rva]  (s_TypeInfoTable, ASLR-stable RVA anchor)
   │     → class_by_index(tbase, idx) → anti-poison gates (name round-trip, instance size,
   │       gold round-trip); PSD/CSD/StageManager via ONE targeted backref sweep (~8 s)
   │  SLOW (guaranteed fallback): 3-pass region scan
   │     pass1 scan class-name strings → pass2 ptr→name validate Il2CppClass → pass3 ptr→class
   │     instances  [il2cpp/resolver.py]; managers picked by STRUCTURAL list validation
   │     (_pick_list_singleton — largest valid List beats junk slots)
   │     + AggregateManager (gold) resolved by STRUCTURE, name-free [metrics/gold.py]
   │  After a successful scan: _calibrate() discovers anchor/indices/idx_ut and persists
   │  calib[fp] into resolve_cache.json (atomic write, completeness+shape gates)
   ▼
Memory polling loop, default 10 Hz (interval = 1/hz)
   ├─ every tick:   live monsters (MONSTER_LIST + SUMMONED_LIST) → DpsTracker (Σ HP drops)
   ├─ every tick:   LOG_LIST tail scan (LogScanCursor, rotation-aware by object pointer)
   │                → StageClearLog / StageFailedLog / GetBoxLog / HeroDieLog / ResurrectionLog
   ├─ ~1 Hz:        live.json snapshot: stage, mobs, damage, gold_now, xp_now, party, drops,
   │                64 stats per hero, per-hero level/exp progress, formation slots
   ├─ 1 Hz refresh: pick_live_csd (catalog-gated), lazy pick_live_sm when party deploys
   └─ dead-read watchdog: LOG_LIST unreadable for ~5 s → discard run, re-attach, re-resolve
   ▼
Raw observations  →  raw/<ts_ms>.json (1 per run, ok/err envelopes) + live.json (~1/s)
   ▼
Run lifecycle detection (close_run on log events; abandon on stage switch / dead-count drop)
   ▼
Completed run record (the Electron app's converter cooks/derives; reader stays raw)
```

Process discovery notes (FACT):
- Process match is by executable name `TaskBarHero.exe` (case-insensitive), first match wins.
- Module identity: `GameAssembly.dll` base via Toolhelp (`ga_module`); all IL2CPP game logic lives
  there. `UnityPlayer.dll` is not touched.
- No admin required for the query+read handle in normal Steam installs (tbh-meter README/usage
  assumes a normal user; `validate_live.py` asks for an admin console, but that is its own
  convenience, not a reader requirement).

## 2. Metric inventory (trace each metric to its actual source)

Poll frequency: 10 Hz loop; the per-hero/live-snapshot block runs at ~1 Hz. "Run-scoped" = reset in
`new_run()` per run; "global" = cumulative process-wide.

| Metric | Memory structure / source | Resolution method | Poll | Raw/Derived | Scope | Reliability | Known failure modes | Version dependency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Run boundary (clear/fail) | `LogManager.LOG_LIST` (`List<LogData>` @0x20), new entries matched by **klass pointer** == StageClearLog/StageFailedLog class | singleton `LogManager` via `nn<T>` static `bbwf`; class by index (fast) or scan (slow) | 10 Hz | raw event | run | high | wrong LogManager instance (dead list) → no run ever closes; list cap 2000 + head eviction (solved by pointer-identity cursor) | LOG_LIST offset stable since initial dump; classes obfuscated-name-stable here |
| Official clear time | `StageClearLog.CLEAR_TIME` @0x48 (int seconds) | read at close from the log entry | on event | raw | run | high | unreadable entry → 0 | offset pinned per build |
| Fail waves | `StageFailedLog.NOW_WAVE/TOTAL_WAVE` @0x48/0x4C | read at close | on event | raw | run | high | — | pinned per build |
| Stage identity | 1.2.8: catalog-gated chain (live monster key → save snapshot `CommonSaveData.CURRENT_STAGE_KEY` on live CSD → last known) | `stage_info` catalog (from `StageInfoData` instances, persisted in calib) resolves act/stage/mode/total mobs | 10 Hz/1 Hz | raw key + derived label | run (adopted in 3 s grace) | medium-high | dead Monster field on 1.2.8 (garbage, needs catalog gate); save snapshot lags ≤1 autosave cycle | **high** — the live field already moved classes once (1.2.8) |
| Difficulty | `StageInfoData.DIFFICULTY` @0x44 via stage key → `EStageDifficulty` | catalog lookup | on stage change | raw | run | high | missing catalog row → mode "?" forever (mitigated by completeness-vs-seed gates) | catalog is build-stable data, re-captured per build |
| Stage switch / manual restart | dead-unit count drop (1.2.8: `StageManager.DEAD_UNIT_DICT` → `Dict.COUNT`; ≤1.00.28: `MonsterSpawnManager.DEAD_MONSTER_LIST` → `List.SIZE`); or stage key change after grace | compare consecutive polls (`dead_now < prev_dead - 2`) | 10 Hz | derived | run | medium | structure moved between versions (List → Dict) | **high** — changed in 1.2.8 |
| Total damage | Σ monster HP drops + killing blow (`UnitHealthController.HP_CURRENT` @0x40 float) via `DpsTracker` | iterate `MonsterSpawnManager.MONSTER_LIST`+`SUMMONED_LIST`, diff per-address HP | 10 Hz | derived (accumulated) | run | high (validated ±) | HP-up (heal/address reuse) ignored; monsters spawning mid-tick counted from first sighting; joining mid-run undercounts (→ partial flag) | Unit base shifts move `HEALTH_CONTROLLER` (Unit grew 0x3A0→0x3D0 across builds) |
| DPS (live) | damage in 5 s rolling window / 5 | `RollingWindow` | 10 Hz | derived | run | high | same as damage | same |
| Mobs killed | alive-count decrements between ticks | count of live monsters | 10 Hz | derived | run | medium-high | mobs dying and respawning within one tick undercount; `total` = catalog `waves×mobs + 1` (boss) | catalog-dependent |
| Gold per run (combat) | **LIVE**: `AggregateManager.AGGREGATES[GoldEarn=2][SubKey 1]` (`Dict<EAggregateType,Dict<SubKey,long>>`, Dict8B geometry) | AggregateManager resolved **name-free by structure** (two-value signature + bbwf singleton round-trip) or by calib index `idx_ut` + round-trip gate | baseline at run start, read at close | raw cumulative → **delta** via `run_gain` | run | high (live-validated to the unit) | non-monotonic read → None (never negative); save-lag when falling back | obfuscated class name drifts (`ut`→`uu`→…) — hence structure/index resolution, never name |
| Gold fallback (save) | `PlayerSaveData.AGGREGATES` (in-memory save snapshot) Type==GoldEarn AND SubKey==1 | `pick_live_psd` (most-gold instance) | read at close | delta | run | low-medium | updates in ~100 s jumps → 0 or ~2× per run (documented live evidence) | PlayerSaveData list offsets shift almost every feature patch |
| Wallet gold | `CurrencySaveData` Key==100001 @0x18 (long) | `read_gold` | on demand | raw | global | high | **must NOT be used for per-run gold** (includes sales/idle/quest) | stable |
| Hero XP per run (live, primary) | `HeroRuntime` (via `Unit.CACHE` → `wj`): level = ACTk ObscuredInt (record@0xCC, hidden@+0x4, key@+0x8), within-level XP = ACTk ObscuredDouble (record@0x110, hidden@+0x8, key@+0x10) | `StageManager.HERO_LIST` (live deployed party, formation slots 0..2) → Unit.CACHE → HeroRuntime; cipher decoded read-only (`game/obscured.py`), key read live each tick; `PartyXpAccumulator` integrates 1 Hz snapshots, bridges level-ups via `level_curve.json` | 1 Hz + final tick at close | derived (accumulated) | run, per hero | high (oracle: decoded level == save level) | dirty reads (dip) don't advance baseline; dead hero banks 0 (real behavior); cap-level heroes gain 0 (phantom XP suppressed) | **very high** — cipher encoding changed 1.00.20 (decoy zeroed), width changed 1.00.27 (float→double), struct offsets move with Unit base |
| Hero XP fallback (save) | `HeroSaveData.EXP` @0x20 (double, in-memory save snapshot) | per-hero delta at close; level_capped → 0 | at close | delta | run | low | resets on level-up (undercounts); save lag; phantom at cap | widened float→double in 1.00.27 |
| Hero level (live) | same ObscuredInt level record | decode + fallback to save level on implausible value | 1 Hz | raw | run/global | high | bad decode → save fallback | cipher-dependent |
| Party composition | `StageManager.HERO_LIST` (`Hero[]`, ≤12 slots, null gaps; identity via `HeroRuntime.INFO → HeroInfoData.HERO_KEY`, gated by `hero_cat` catalog = ghost discriminator) | `pick_live_sm` = first candidate with ≥1 deployed catalog hero; ghost StageManager instances are common (441 candidates, 1 carrier in the 1.2.8 validation) | 1 Hz + close | raw | run | high | sm unresolved when out of combat → honest degradation (heroes:err, run sealed degraded), never the save roster | Unit.CACHE offset dependency |
| Formation slots | index in `HeroList` (0/1/2) | `read_party_slots`, coherent at-close read + accumulator fallback (dedup) | 1 Hz | raw | run | high | stale fallback dropped on collision | with Unit.CACHE |
| Hero stats (64 final) | `HeroRuntime.STATS_HOLDER → StatsHolder.FINAL_STATS` `Dict<StatType,float>` (DictFloat geometry) | per deployed hero | at close (also 1 Hz for overlay) | raw | run | high | wrong Dict geometry (Dict8B vs DictFloat) corrupts | StatsHolder is obfuscated-class, live-gated |
| Equipment / skills / build sheet | save-snapshot structures: `PlayerSaveData.HEROES → HeroSaveData.EQUIPPED_ITEMS` (ulong[] uniqueIds) → `ITEMS` (ItemSaveData: itemKey, ENCHANT_DATA mods), `EQUIPPED_SKILLS` (int[]), `ATTRIBUTES` (skill tree levels), `RUNES`, `INVENTORY_SLOTS`, `STASH`; catalogs `ItemInfoData`/`HeroInfoData` for grade/slot/class | `read_build` / `read_account_snapshot` at close | at close (frozen at run start for build) | raw | run / account snapshot | high when offsets current | unknown equipped uid → sentinel UNKNOWN_ITEM_KEY −1 (never silent empty); list shifts break silently → live-gated [build-record] check | **PlayerSaveData offsets are the most churn-prone area** (5 shifts documented) |
| Chest drops | `GetBoxLog.MONSTER_TYPE` @0x50 (tier 0/1/2); BOX_KEY_BY_TIER maps to canonical box item key | log event; boss chests trail the clear ~0.6 s → pending-close grace 3 s absorbs into the closing run | on event | raw | run | high | boss box without pending → credited to current run + WARN (never dropped) | offsets pinned |
| Hero deaths/revives/killers | `HeroDieLog.VICTIM_HERO`@0x48 / `KILLER_MONSTER`@0x40; `ResurrectionLog.HERO`@0x40 (`"Name_<key>"` strings) | log events, suffix-parsed | on event | raw | run | high | string parse failure → skipped entry | offsets pinned |
| Game version | `Version.txt` beside the exe | `_detect_game_version` via process image path | at attach + re-attach | raw | global | high | unreadable → GAME_VERSION fallback constant | n/a |
| Build fingerprint | PE header of GameAssembly.dll: `f"{version}-{TimeDateStamp:#x}-{SizeOfImage:#x}"` | `build_fingerprint` | at attach + re-attach | raw | global | high | TimeDateStamp may be 0 (deterministic builds) → version+SizeOfImage carry identity | n/a |

INFERENCE on "displayed ≠ measured": DPS/damage/mobs are **derived** from HP polling, not read
from any game-stored damage counter; XP is derived from decoded within-level increments plus a
level curve; gold is a delta of a cumulative. Only the cumulative counters, HP values, log events
and save structures are directly measured.

## 3. Resolution / calibration model (how offsets survive updates)

Three-layer model (FACT, `docs/guides/game-update.md` + code):

1. **Never changes** — PE/OS format and IL2CPP/Unity ABI (`String`/`Array`/`List`/`Dict`/`Class`
   layouts in offsets.py). Only an engine upgrade moves these.
2. **Self-heals per build** — fingerprint, `anchor_rva`, TypeDefIndices (`indices`, `idx_ut`),
   catalogs (stage/item/hero). The guaranteed 3-pass scan rediscovers them; `save_calib` persists
   `calib[fp]`; the bundled seed (`calib_seed.json`) ships them pre-captured so first launch is
   ~ms instead of ~190 s. The fast path re-validates live every launch (name round-trip, instance
   size, gold round-trip) — a bad calib degrades to the scan, never poisons.
3. **Breaks silently** — per-class field offsets + enums. Detected by the static preflight
   (`diff_offsets_vs_dump.py` compares `offsets.py` against a fresh IL2CPP dump of
   `GameAssembly.dll` + unencrypted `global-metadata.dat`, magic `af1bb1fa`) and by the live
   validation gate (`validate_live.py`, 13 checks, all-metrics rule).
4. **Breaks silently, encoding-level** — ACTk Obscured encoding changes with **zero offset
   movement** (1.00.20 zeroed the fakeValue decoy build-wide). Only the live oracle catches this.

Name-drift defense (FACT): every obfuscated class (AggregateManager, HeroRuntime, StatsHolder) is
resolved by **index** (calibrated TypeDefIndex) or **structure** (signature + singleton
round-trip), never by its drifting 2-letter name. Names are used only for validation round-trips.

### Answer: could the reader produce plausible-but-incorrect values after an update?

**Yes — three documented classes** (FACT, from the repo's own history):

1. **Silent offset shift** — e.g. PlayerSaveData list shifts (1.00.12: read_gold=0 → runs without
   gold; 1.00.27; 1.2.8): the read lands on a *different valid-looking* list and produces
   plausible wrong data or empty structures without any error.
2. **Encoding change with stable offsets** (1.00.20): every offset green in the static diff, live
   reads decode to 0/garbage.
3. **FALSE-OK blind spots** — obfuscated-name fields where the old offset lands on another
   obfuscated field of the same shape, so a uniform-shift heuristic passes silently
   (`Monster.STAGE_KEY` is the documented example; in 1.2.8 the field left the class entirely and
   the shifted offset reads `befr`, an int).

Additionally the fingerprint only keys the **fast path**; a *miss* is safe (cold scan), but the
per-class offsets are keyed by nothing — they are global constants per reader release. That is the
core fragility TBH Core must improve on.

### How TBH Core should prevent it (RECOMMENDATION)

- Key **everything build-dependent** (offsets, indices, anchor, catalogs, cipher params) by the
  same build fingerprint, so a fingerprint change disables the whole layout instead of silently
  reusing it. (tbh-meter keys only calib by fp; offsets are global.)
- Run a **startup health battery** equivalent to validate_live's 13 checks in cheap form
  (gold round-trip vs save, decoded level vs save level, catalog membership of the live stage,
  party plausibility) before promoting MemoryRunSource to healthy.
- Persist the **observed fingerprint with every run record** (tbh-meter records `game_version`
  but not the fingerprint — TBH Core should record both) so historical runs can be re-assessed if
  an offset bug is later discovered.
- Treat "unknown fingerprint" as UNSUPPORTED (fail safe), never "try anyway".

## 4. Proposed TBH Core compatibility states (RECOMMENDATION)

| State | Entry | Exit | Observable behavior |
| --- | --- | --- | --- |
| `DISCONNECTED` | start; game process not found; or attach failed | process found + handle opened | UI shows "waiting for game"; re-poll with backoff; no partial data shown |
| `DETECTING` | handle opened | fingerprint computed + resolution attempted | version+fp read, resolution in progress (fast path or scan); no metrics published |
| `HEALTHY` | resolution complete AND startup health battery green (gold round-trip, xp oracle level==save ±1, stage resolves, party ≥1 hero when in combat) | any health check fails / process exits | metrics published with measured confidence |
| `DEGRADED` | a sub-source failed its gate (e.g. live gold fell back to save; live xp off; stage from snapshot) while core run-boundary detection still works | the sub-source passes its gate again (self-heal, e.g. re-resolve gold klass) | runs still recorded, affected fields flagged with source + degraded confidence; counts toward analytics only for unaffected metrics |
| `UNSUPPORTED_GAME_VERSION` | fingerprint not in the compatibility table (no validated offsets/calib) | table updated by an app/release update | **no memory metrics** (fail safe); save/log sources keep working; UI states the version explicitly |
| `CALIBRATION_FAILED` | scan/resolution did not converge (incomplete managers) | retry/relaunch with game in combat | no metrics; diagnostic surfaced; auto-retry |

Notes (RECOMMENDATION): DISCONNECTED↔DETECTING transitions repeat on game restart
(tbh-meter: dead-read watchdog ≥5 s → discard in-flight run → re-attach → re-resolve; the run
interrupted by a game exit is discarded, never half-recorded). State must be per-source, recorded
into persistence with runs, and drive the confidence labels in analytics.

## 5. What TBH Core should adopt vs avoid (RECOMMENDATION summary)

Adopt:
- read-only handle discipline (QUERY+VM_READ only, single attach point);
- fingerprint = version + PE TimeDateStamp + SizeOfImage, recomputed at every (re)attach;
- name-free resolution (index/structure) with round-trip anti-poison gates;
- ok/err envelopes + `*_source` tags (never conflate didn't-read with zero);
- run boundary from LogManager events with pointer-identity cursor (rotation-safe);
- per-run metric chains LIVE→SAVE with self-heal on degradation;
- pending-close grace for trailing boss chests (3 s);
- honest degradation (heroes:err instead of roster, run sealed degraded);
- calibration seed concept keyed by fp; catalogs persisted per fp with completeness gates.

Avoid / improve:
- global (non-fp-keyed) offset constants;
- trusting a static offset diff without a live oracle;
- process-name-only identity (add exe path validation, e.g. must contain `TaskBarHero`);
- first-match process pick if multiple game instances can exist.
