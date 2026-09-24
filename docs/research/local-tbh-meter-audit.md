# Phase A research — local updated tbh-meter audit

Audit date: 2026-09-24. All facts below were verified read-only against `D:\VSC\tbh-meter`.
Nothing in that repository was modified (no reset/checkout/stash/commit/clean; no fetch inside it —
upstream state was confirmed through the GitHub REST API instead).

## 1. Exact repository state

| Property | Value |
| --- | --- |
| Path | `D:\VSC\tbh-meter` |
| Branch | `main` |
| HEAD | `5bc35e82b514b45814047de57551d08da62c9195` |
| Remote (origin) | `https://github.com/mad-labs-org/tbh-meter.git` (fetch + push) |
| Shallow clone | yes (`git rev-parse --is-shallow-repository` → true; `git rev-list --count HEAD` → 1) |
| Upstream tip (GitHub API, same day) | `5bc35e82b514b45814047de57551d08da62c9195` — identical to local HEAD |
| Committed delta vs upstream | **zero** — local HEAD *is* the upstream `main` tip |
| Uncommitted delta | 29 modified files, ~21,299 insertions / ~19,352 deletions (dominated by a full `calib_seed.json` reseed) |
| Untracked | `reader/build/`, `reader/dist/`, `reader/tbh-reader.spec`, `reader/scripts/validate_live_out.txt` |
| Game version targeted | **1.2.8** (upstream HEAD targets 1.00.28; see §3) |

Upstream HEAD commit message (for context): `fix(reader): recalibrate for game build 1.00.28 (#109)`,
with a note that the 1.00.28 recompile shifted only the IL2CPP metadata index table and that the
1.00.27 `ObscuredDouble` XP cipher still decoded on 1.00.28.

The untracked `reader/scripts/validate_live_out.txt` is **live validation evidence** for the local
1.2.8 adaptation — see §4. It is the output of `reader/scripts/validate_live.py` run against the
running game (`pid 6256`, build `1.2.8`, fingerprint `1.2.8-0x6ab23e8a-0x6b47000`).

Because the committed delta is zero, the entire local adaptation lives in the working tree.
Classification of that diff follows in §3.

## 2. Upstream architecture (context for the diff)

tbh-meter is two processes:

- **`reader/`** — a zero-dependency Python memory reader (frozen to `tbh-reader.exe` via
  PyInstaller). Strictly read-only: `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` +
  `ReadProcessMemory` only (`reader/shared/memory.py`). A "dumb sensor": it emits raw observations
  to files and derives nothing presentation-related.
- **`app/`** — an Electron app that spawns/supervises the reader (`app/src/main/reader-process.ts`),
  converts raw per-run records (`raw/<ts_ms>.json`) into cooked run records (`converter/`), derives
  sessions, and renders the UI/overlay.

Reader-side modules relevant to this audit: `meter_windows.py` (orchestrator), `config/offsets.py`
(the "offset bible"), `il2cpp/` (resolver/finder/typeinfo — name-free class resolution),
`game/` (build/save/models/obscured — domain reads), `metrics/` (gold/xp/dps/events),
`scripts/` (calibration + validation tooling). Wire contracts: `raw/<id>.json` per run
(`RAW_SCHEMA_VERSION = 2`, id = run END timestamp in ms), `live.json` (~1 Hz snapshot). Every data
field rides an ok/err envelope distinguishing "didn't read" from "read zero".

## 3. What was fixed / updated locally (the uncommitted diff)

Game version context: upstream targets 1.00.28; the local diff adapts the reader to **TBH 1.2.8**
(a major-version jump, not a patch bump). All classification below is verified from
`git diff` output read during this audit.

### 3.1 `reader/config/offsets.py` — GAME VERSION ADAPTATION / OFFSET CHANGE

| Symbol | Upstream (1.00.28) | Local (1.2.8) | Why |
| --- | --- | --- | --- |
| `Unit.CACHE` | `0x3B0` | `0x3D0` | Unit base tail grew +0x20 in 1.2.8 (new fields `beie`/`beif` Coroutines, `beig` float at 0x3B0–0x3C8). Every Unit subclass field shifts with it. Marked as a diff FALSE-OK blind spot (obfuscated names). |
| `Monster.STAGE_KEY` | `0x3DC` | `0x3FC` | Uniform Unit-tail shift. **Caveat recorded in the diff itself**: the stageKey field semantically LEFT the Monster class; `0x3FC` now lands on another obfuscated int (`befr`) — the read returns garbage and must be catalog-gated by the caller (see 3.3). |
| `Monster.CACHE_OBSCURED` | `0x3C0` | `0x3E0` | Uniform Unit-tail shift (marker for the obscured-offlimits invariant). |
| `StageManager.DEAD_UNIT_DICT` | — (new) | `0x118` | 1.2.8 moved dead units from `MonsterSpawnManager.DEAD_MONSTER_LIST` (a `List<Unit>`) to `StageManager`'s `Dictionary<int, DeadUnitData>`. Read via `Dict.COUNT` for the manual-restart detector. |
| `MonsterSpawnManager.DEAD_MONSTER_LIST` | `0x30` | removed | The dead list is GONE from this class in 1.2.8. |
| `MonsterSpawnManager.SUMMONED_LIST` | `0x38` | `0x30` | Class restructure (`m_spawnPositionMonster@0x20`, `IsForceEnterBossWave@0x38`). |
| `CommonSaveData.CURRENT_STAGE_KEY/WAVE` | `0x58/0x5C` | `0x64/0x68` | New field `firstUnlockHeroKey@0x58` inserted above. |
| `PlayerSaveData.CURRENCIES…AGGREGATES` | `0x58…0xB8` | `0x60…0xC0` | Fifth cumulative shift (+0x08 plus mid-list inserts: `pendingItemRestorationList@0x58`, `mailSaveDatas@0x70`, `PetSaveData@0x80`, cube fields 0xA0–0xB0). New dump TypeDefIndex 872. |
| `HeroSaveData.EQUIPPED_SKILLS` | `0x38` | `0x40` | New `equippedItemBlocked` bool[] @0x38 between the equipped arrays. |
| `ItemSaveData.ENCHANT_DATA` | `0x30` | `0x40` | New `RegisterID` string @0x30 + `EnchantCount` int[] @0x38 above EnchantData. |
| `ItemInfoData.PARTS` | `0x3C` | `0x40` | Field shifted in above it (dump: PARTS@0x40, GEARTYPE@0x44). |
| `HeroRuntime` (comment only) | class `uy`, TypeDefIndex 2800 | class `wj`, TypeDefIndex 1008 | Obfuscated name/index drift; **internal layout unchanged** (INFO@0x30, level record@0xCC, xp record@0x110). |

Version-specific? Yes — all of the above is 1.2.8-specific offset work. Pattern (documented in the
file's own comments): `PlayerSaveData` list shifts have happened on 1.00.12, 1.00.19, 1.00.23,
1.00.27 and now 1.2.8 — save-adjacent classes drift whenever the devs add persisted features.

### 3.2 `reader/config/calib_seed.json` — OFFSET/CALIBRATION CHANGE

Full reseed for fingerprint `1.2.8-0x6ab23e8a-0x6b47000`
(`anchor_rva` 103807248, `idx_ut` 1041, 15 named indices, 180 stages incl. 12 ACTBOSS,
6250 items, 22 heroes). This is the calibration payload that makes the fast path work on 1.2.8.

### 3.3 `reader/meter_windows.py` — GAME VERSION ADAPTATION + RUN DETECTION CHANGE + READER RELIABILITY

- `GAME_VERSION` fallback: `"1.00.28"` → `"1.2.8"` (the installed version still comes from the
  game's `Version.txt` at runtime).
- **Live stageKey chain rebuilt**: `Monster.STAGE_KEY` is dead on 1.2.8 (reads garbage). New chain:
  live monster read **gated by the stage catalog** (an out-of-catalog key is not a stage) →
  fallback to the save snapshot `CommonSaveData.CURRENT_STAGE_KEY` on the live-picked CSD
  (updates on stage change, may lag one autosave cycle) → otherwise keep last known key.
- **Restart detector re-pointed**: dead-unit count now reads
  `StageManager.DEAD_UNIT_DICT` → `Dict.COUNT` instead of
  `MonsterSpawnManager.DEAD_MONSTER_LIST` → `List.SIZE`. Same semantics (cumulative count that
  drops on a manual stage reload).
- Imports updated (`Dict`, `StageManager` added; `MonsterSpawnManager.DEAD_MONSTER_LIST` gone).

### 3.4 `reader/game/models.py` — READER RELIABILITY (doc)

`live_stage_key` docstring updated: on 1.2.8 the read returns garbage; the CALLER gates by catalog
and falls back to the save snapshot. No logic change (the function still reads + modes the first
few monster keys).

### 3.5 `reader/scripts/validate_live.py` — BUG FIX (validation gate) + ADAPTATION

- **XP sanity fix**: the old `dec_xp >= 0.0` check let denormal garbage (~1e-300 from a wrong
  64-bit reinterpretation) pass the oracle. New rule: a real within-level XP is either exactly 0
  (just leveled) or ≥ 1 (the level curve's cheapest step is 30 XP). This is a genuine validation
  hardening, not version-specific.
- **Stage check adapted**: PASS when EITHER the live monster key OR the save snapshot resolves a
  catalog entry (upstream required live-only, which cannot work on 1.2.8). Mirrors the meter's new
  fallback chain; `pick_live_csd`'s catalog validation kills the 1.00.17 garbage-instance false
  positive the old live-only gate guarded against.

### 3.6 `app/src/main/auto-update.ts` — OTHER (local-build hack)

`updaterSupported()` now returns `false` unconditionally — every update path funnels through this
flag, keeping the updater dormant in the local build. **This is a local machine-specific change;
TBH Core must NOT reproduce it** (TBH Core ships its own update strategy).

### 3.7 `app/src/main/index.ts` — BUG FIX (UI, high-DPI overlay drag)

Upstream had a self-sustaining resize tick loop: during a width-resize drag, mid-drag
`pinLiveHeight` issued a second concurrent `setBounds` racing the drag's own `setLiveWidth`;
pointer capture re-posted `WM_MOUSEMOVE` on every geometry change, widening the window while the
button was merely held. Local fix:

- `liveMoveActive: bool` → `liveDragMode: "move" | "resize" | null` (freeze geometry during
  either drag kind);
- round-before-compare on `getBounds()` (fractional-scale displays return fractional bounds while
  everything written is integral — the exact compare was always dirty, feeding the churn);
- settle BOTH modes on release (`pinLiveHeight` + one save), so transient mid-loop widths are
  never persisted (restored bounds no longer become the next session's inflated baseline).

Electron/Windows-specific; version-agnostic. Relevant to TBH Core only if it ever ships a
resizable overlay (current TBH Core plan: single window — noted as a lesson, not a requirement).

### 3.8 `app/src/renderer/src/lib/run-list-filter.ts`, `views/RunListView.tsx`, `app/src/shared/i18n/*` (18 locales) — UI CHANGE

New sortable derived columns EXP/h and Gold/h in the run list (`rate × 3600`, computed in the
cell/sort — monotonic transform of the stored per-second rate; not persisted). Purely presentational.

### 3.9 `reader/tests/*` — TEST UPDATES

`test_offsets.py` (AGGREGATES 0xB8→0xC0 with the full shift history comment),
`test_obscured_markers.py` (CACHE_OBSCURED 0x3E0),
`test_diff_offsets_vs_dump.py` (+48 lines — 1.2.8 dump-adaptation of the static diff tripwire;
not yet read in detail — see NOT TESTED), and the invariant doc marker assertion
(`docs/invariants/obscured-data-offlimits.md` CACHE_OBSCURED assert).

## 4. Live validation evidence (FACT)

`reader/scripts/validate_live_out.txt` (untracked, read during this audit) shows the local
adaptation was validated against the running game:

```
[ok] attached (pid 6256) | build 1.2.8 | fp 1.2.8-0x6ab23e8a-0x6b47000
[ok] resolved in 6s
===== LIVE VALIDATION (build 1.2.8) =====
[PASS] calib/seed — seed covers fp (idx_ut=1041)
[PASS] gold — klass=0x25601dae000 live=11934046
[PASS] party-live — sm=ok deployed=3 keys=[201, 301, 401]
[PASS] hero-class — classIds=[4, 3, 2]
[PASS] save-build — psd=ok saveGold=2145931 saveHeroes=4
[PASS] build-record — heroes=4 withGearOrSkills=4 snapshot=[248, 15, 70]
[PASS] xp-live — hk401:lv35=save35? xp=2.154e+07 hk301:lv35=save35? xp=2.218e+07 hk201:lv36=save36? xp=1.817e+06
[PASS] party-slots — slots={401:0, 301:1, 201:2} == herolist_index
[PASS] dps — monsters=2 withHpMax=2
[PASS] stats — heroesWithStats=3 sizes=[65, 65, 65]
[PASS] stage — live=910401 (OUTSIDE) snapshot=2205 (in)
[PASS] run-cycle — lm=ok logList=ok size=628
[PASS] catalogs — stages=180 (ACTBOSS=12) items=6250 heroes=22
[OK] ✅ ALL PASS
```

Notable corroboration: the `stage` line shows `live=910401 (OUTSIDE)` — the dead Monster read
producing an out-of-catalog value — while the snapshot `2205 (in)` resolves. This is exactly the
degradation path the local diff implements.

## 5. Should TBH Core reproduce this behavior?

| Local change | Reproduce in TBH Core? |
| --- | --- |
| Offset table values for 1.2.8 | Yes, as *data* for a 1.2.8 compatibility entry — but TBH Core needs its own offset/compat table format (see `memory-source.md`). The values themselves were live-validated here. |
| Catalog-gated stageKey + save-snapshot fallback | Yes — the pattern (gate by catalog, fall back, keep last known) is sound and version-tolerant. |
| `DEAD_UNIT_DICT` restart detector | Yes (semantic: "cumulative dead count that drops on manual reload" — the backing structure differs per version). |
| validate_live XP denormal sanity | Yes — cheap and catches a real garbage-decode class. |
| validate_live stage either/or | Yes, with the same pick_live_csd catalog validation. |
| Overlay drag-loop fix | Not directly (no overlay in MVP); document the Electron fractional-scaling lesson. |
| Updater disable | No — local hack, opposite of TBH Core's release strategy. |
| EXP/h, Gold/h columns | Derivation is trivially reimplementable; not a dependency. |

## 6. NOT TESTED / limitations of this audit

- The 1.2.8 dump.cs itself was not inspected (it lives outside this repo, `re/dump/dump.cs`
  referenced by offsets.py comments); offset *derivations* are taken from the diff's own
  annotations plus the live validation evidence, not re-derived from a dump.
- `reader/tests/test_diff_offsets_vs_dump.py` diff detail (+48 lines) not fully read;
  classified from filename/pattern. Reason: secondary evidence for the same offset changes already
  verified from `offsets.py`. Validation procedure if needed: read the hunk in the working tree.
- No live game session was run by this audit; the validation evidence above was produced by the
  repository's maintainer before this audit started.
