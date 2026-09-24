# Phase A research — Player.log source audit

Usage studied in: **tbh-codown** (desktop + web variants — the deepest usage), **tbh-companion**
(single regex), and checked across the rest (tbh-meter, TBH-Optimizer, tbh-copilot,
giba-steam-market, TBH-DPS-dashboard: none parse Player.log; TBH-Optimizer even filters it out of
its save-directory watcher as noise).

## 1. Fundamentals

- Path: `<save dir>/Player.log` (same directory as `SaveFile_Live.es3` —
  `%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskbarHero\`). `Player.prev.log` (previous
  launch) sits alongside; nobody parses it.
- Unity writes it unencrypted; the game rewrites it on each launch (truncation), appends during
  play.
- Tailing mechanisms seen:
  - tbh-codown desktop: file kept open (`utf-8`, `errors=replace`), seek to EOF at start, drain
    `readline()` per poll (0.35 s); truncation/rotation detected via `(st_ino, st_size)` change →
    reopen at end; startup seeds baselines from the last 400 lines so no phantom events.
  - tbh-companion: offset-based append reader (poll 1 s, `readFileTailUtf8` from stored offset;
    `size < offset` → restart from 0), seeks to EOF at start (only post-launch drops count).
  - tbh-codown web: whole-file re-read every 5 s + line-signature dedup (`${lineNumber}:${itemKey}`).

## 2. Event patterns (everything found, across all repos)

| Pattern | Regex (as implemented) | Found in | Semantics |
| --- | --- | --- | --- |
| Chest count query | `GetBoxCount Success Count\s*:\s*(\d+)\s*//\s*ItemKey\s*:\s*(\d+)` (tbh-companion variant accepts `;` as well) | tbh-codown (`log_watcher.py:12`, plus JS ports), tbh-companion (`core/playerLog.ts`) | The game **querying the owned count** of a box item key (group 1 = current owned count, group 2 = item key). Logged on Steam inventory sync AND on actual drops AND on auto-open — **a line is NOT a drop**; only a count INCREASE for a chest key is. Sample: `GetBoxCount Success Count : 1 // ItemKey : 920301`. |
| — | No other game event patterns exist in any reference repo | (verified by grep across all clones) | No stage/scene lines, no boss/kill/run events, no error signatures, no version/build lines are parsed anywhere. |

Chest item-key taxonomy (tbh-codown catalogs, wiki-derived): `91xxxx` = Normal Monster Box,
`92xxxx` = Stage Boss Box, `93xxxx` = Act Boss Box; boss→common key mapping is string-level
(`"91" + boss_key[2:]`).

## 3. Classification of Player.log per event type (RECOMMENDATION)

| Event | Classification | Rationale |
| --- | --- | --- |
| Chest drop (count-increase of a watched chest key) | **CONFIRMATION ONLY** | Near-real-time signal but noisy: Steam inventory recounts produce bursts (≥3 distinct keys seen once → drop the batch unless a key actually increased); auto-opened chests emit flat `Count : 1` lines; the SAVE's BoxData aggregate is the authoritative count. Best pattern (tbh-codown): log detects fast, save confirms, 12 s cross-source dedup window counts once. |
| Stage attribution for a drop | **SUPPLEMENTARY** | The log has no stage lines; stage comes from the save's currentStageKey with a ~20 s previous-stage grace window on transitions. |
| Run start/end/outcome | **UNRELIABLE (absent)** | No evidence any run/battle/clear/fail line exists. Run boundaries come from memory (StageClearLog/StageFailedLog via LogManager) — a different channel from this file. |
| Game version/build | **UNRELIABLE (absent)** | No version lines parsed by anyone; version comes from `Version.txt` (memory projects) or `commonSaveData.version` (save). |
| Errors | **SUPPLEMENTARY at best** | Nothing parsed in references; Unity stack traces exist in principle but no project relies on them. |

## 4. Noise filters required if chest detection is ever built (from tbh-codown, FACT)

1. Count baselines per key; emit only on `count > previous`; decreases (chest opened) silently
   update the baseline.
2. Startup tail seeding (last 400 lines) so history doesn't emit phantom drops.
3. Inventory-sync burst filter: ≥3 distinct keys each seen once in one poll batch → recount,
   drop (preserve keys that actually increased or belong to current/previous stage within the
   20 s transition window).
4. Flat-count-1 gate: repeated `Count : 1` (auto-opened chests) accepted only for watched keys
   with cooldown elapsed, timer not counting, post-30 s startup grace, and an emitted-latch.
5. Cross-source dedup vs save-side box-aggregate detection (12 s window) so one drop counts once.
6. Stage attribution: current stage from save; non-matching key → previous stage if transition
   <20 s ago, else discard.

## 5. TBH Core posture (RECOMMENDATION)

- MVP: implement Player.log as an **optional supplementary source for chest events only**,
  using the single proven pattern + the filters above; label events `PLAYER_LOG` provenance with
  `supplementary` confidence; never let it define runs, XP, gold, or version.
- Health: watch for pattern staleness (no matching lines for a long session while the save shows
  chest changes → pattern likely changed in a game update → mark source degraded, not silent).
- NOT TESTED: no live Player.log was parsed in this phase; pattern efficacy is from reference
  source reading only. Validation procedure when implemented: run the game, farm a stage,
  confirm each GetBoxCount increase corresponds to a BoxData quantity increase in the save.
