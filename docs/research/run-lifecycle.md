# Phase A research — run lifecycle

Comparison of how reference projects define and detect a "run", race conditions, and the canonical
lifecycle proposed for TBH Core. Sources: local tbh-meter (primary, memory-based), TBH-Optimizer
(save-window-based), TBH-DPS-dashboard (in-process stage-state-based), tbh-codown / tbh-copilot /
giba-steam-market (no run concept — noted for completeness).

## 1. Detection approaches across projects

### tbh-meter (FACT — `reader/meter_windows.py`, `docs/invariants/run-lifecycle.md`)

A run = **one stage attempt**. There is no explicit start signal; the lifecycle is *inferred*:

- **RUN_START**: implicit — the next run begins the moment the previous one closes
  (`close_run(...)` → `R = new_run()`). `new_run()` captures all baselines (gold cumulative,
  per-hero XP accumulator seeded with the t=0 party, hero sheet, DPS tracker, drops, deaths).
- **Stage adoption**: the run adopts the currently-played stage key; a 3 s `adopt_until` grace
  after start handles auto-replay/advance right after a clear (the new run adopts the new stage
  instead of staying glued to the old one).
- **RUN_CLEAR / RUN_FAIL**: a NEW entry in `LogManager.LOG_LIST` whose **klass pointer** equals
  the `StageClearLog` / `StageFailedLog` class. New-entry detection is rotation-aware
  (`LogScanCursor` tracks entry **object pointers**, not indices — the list is capped at 2000 and
  evicts from the head, which permanently desyncs an absolute-index cursor once saturated).
  Official clear time is read from the log entry (`StageClearLog.CLEAR_TIME`).
- **RUN_ABANDON**: after the adoption grace, either (a) the stage key changed (player switched
  stage without clearing/failing) or (b) the cumulative dead-unit count **dropped** (manual
  restart of the same stage reloads it; clear/auto-replay do not zero it). Closed with the stage
  that was being played.
- **RUN_RESTART**: same-stage restart manifests as the dead-count drop above → the in-progress
  run is closed as `abandoned` and a new run starts.
- **Game exit mid-run**: reads fail (Reader returns None); after ~5 s of sustained dead reads the
  interrupted run is **discarded** (never half-recorded), the pending success record is flushed,
  and the reader re-attaches when the game returns (re-detecting version/fingerprint, in case the
  restart was an update).
- **Trailing boss chest**: the boss chest `GetBoxLog` arrives **~0.6 s AFTER** the
  `StageClearLog` (proven live on 1.00.11) in a separate list growth. A success close therefore
  pends its file write for `PENDING_CLOSE_GRACE = 3.0 s` and absorbs late boss boxes into the
  closing run; the close itself is NOT delayed (delaying would leak the next run's first seconds
  into the record). Trade-off: a hard kill inside the 3 s window loses that record.
- **Skip/partial predicates** (the accounting spec, applied downstream by the converter):
  - skip: `max(measured, clear_time) < 30 AND stage != 10` (x-10 boss fights can last seconds;
    `stage` is the stage NUMBER, not `EStageType`); converter floor revisits 30 s → 15 s, the
    x-10 exception is the invariant;
  - partial: `success AND ((clear_time >= 30 AND measured < 0.95·clear_time) OR total_damage <= 0)`
    — the meter joined mid-run or captured nothing.

### TBH-Optimizer (FACT — `internal/turnProcessor.go`)

No memory, no logs: a "run" = **the window between two save writes in which
`commonSaveData.currentStageWave` returns to 0**. Because the save quantizes time (autosave
~every 3 min or on events), the entire design is rejection heuristics fighting that quantization:
first-window-after-startup discarded (partial), map-switch windows discarded, mid-window stage
visits discarded, wave regression = restart = discard, level-up in window = discard (XP threshold
distortion), time outliers vs own average (3×) or DPS estimate rejected, "gold spike without XP
spike" = sale → rejected, streak-based acceptance (reject once; accept when the same anomaly
repeats N times). Success/fail is **inferred** (wave regression / low gold treated as death),
never a game flag; abandoned runs surface as "time too long" rejections.

### TBH-DPS-dashboard (FACT — `OverlayBehaviour.PollStageState`, in-process)

Run boundaries from the `StageManager.stageState` enum
`EStageState { NONE=0, MONSTERSPAWN=1, BATTLE=2, REORGANIZATION=3 }`, per-frame polling:
- start = first `MONSTERSPAWN` after idle (`_currentWave == 0`);
- end = **deferred NONE**: with a 1-hero party the state flickers through NONE *between waves*, so
  a bare NONE is not a boundary — NONE is stamped and confirmed only if no `MONSTERSPAWN` within
  `RoundGapSeconds = 2.0 s`, or a stage-id change arrives (hooked at the stage-entry UI method),
  or a mid-run stage switch happens;
- no success/fail/abandon distinction ("run" = stage attempt); runs with 0 hits/0 damage are not
  saved; auto-start if damage arrives with no boundary.

### tbh-codown / tbh-copilot / giba-steam-market (FACT)

No run concept. tbh-codown: unit of work = chest drop (log count-increase + save box aggregate
confirmation, 12 s cross-source dedup). tbh-copilot: per-stage clear **rate** from deltas of the
save's cumulative total-clears counter (aggregate Type=15) + wallet/party-exp rate sampling,
with a 5–900 s plausibility window to reject idle gaps as "clears". giba: pure stash valuation.

## 2. Race conditions and edge cases — cross-project evidence

| Case | Evidence / handling |
| --- | --- |
| Extremely fast clear (x-10 boss, seconds) | tbh-meter: skip predicate exempts stage 10; partial predicate gated `clear_time >= 30` so x-10 is never mislabeled partial, with the `total_damage <= 0` backstop. tbh-copilot: 5 s lower plausibility bound. |
| Very long run | tbh-meter: fine (10 Hz polling, LOG_LIST boundary); tbh-Optimizer rejects as idle contamination (3× outlier); TBH-DPS: 15-min upper plausibility bound in tbh-copilot's analog. |
| Player switches stage mid-run (no clear/fail) | tbh-meter: stage-key change after grace → `abandoned` close with the OLD stage. TBH-Optimizer: window discarded (mixed time). TBH-DPS: stage-id change finalizes run stamped with its starting stage. |
| Player restarts same stage manually | tbh-meter: dead-unit cumulative count DROPS on manual reload (clear/auto-replay don't zero it) → abandon + fresh run. TBH-Optimizer: wave regression mid-window → discard. |
| Defeat | tbh-meter: `StageFailedLog` event (klass pointer) → `fail` with wave progress; HeroDieLog/ResurrectionLog give per-hero deaths/revives/killers. Save-only projects: inferred (wave regression), not a flag. |
| Abandon (quit stage) | tbh-meter: explicit `abandoned` outcome with the run still recorded. Save-only: invisible (never reaches a wave-0 boundary). |
| Game exits mid-run | tbh-meter: 5 s dead-read watchdog → discard interrupted run, flush pending, re-attach on return (re-fingerprinting — the restart may be an update). |
| TBH Core / meter starts during an active run | tbh-meter: the first run is measured from attach → `partial` flag (capture < 95 % of official clear or zero damage) and downstream exclusion; the LOG_LIST cursor is *seeded* to the current tail so the pre-existing backlog is not replayed as events. |
| Meter/app restarts during a run | Same as above (fresh attach = fresh baselines). tbh-meter additionally: run identity = END timestamp (ms), never a counter, so restarts can't collide ids. |
| Level-up during a run | tbh-meter: XP accumulator bridges the level-up via the level curve (validated: 3 level-ups, diff 0); at-cap heroes' phantom increments suppressed. TBH-Optimizer: window discarded outright. TBH-DPS: cumulative exp — no issue. |
| Save during the run / after several runs | tbh-meter: save snapshot only ever a *fallback* (its per-run delta is 0 or ~2× depending on where writes land — documented live: off by +25 k in one run, +1.18 M in another). tbh-Optimizer lives entirely on this quantization (hence the rejection machinery); TBH-DPS documents "most rounds read gold delta=0, one round gets the lump". |
| Loading screens / between waves | tbh-meter: monsters empty between waves → stage key keeps last known; DPS window simply idles. TBH-DPS: REORGANIZATION state + the deferred-NONE logic (wave flicker). |
| Events after close (boss chest) | tbh-meter: pending-close grace absorbs trailing box into the closing run. |
| Duplicate/backlog events on attach | tbh-meter: cursor seeding skips backlog. |

## 3. Canonical run lifecycle for TBH Core (RECOMMENDATION)

Adopt the tbh-meter model — it is the only one with per-run exactness and explicit outcomes —
with TBH Core's own state/contract names:

```text
                    (memory source healthy, in-stage)
  ┌─────────┐  StageClearLog    ┌─────────┐
  │ RUN_ACTIVE ├──────────────► │ CLOSING │──(grace 3s: absorb trailing boss chest)──┐
  └────┬────┘   StageFailedLog  └─────────┘                                          ▼
       │        ─────────────►  flush immediately (fail)                    CompletedRun(success)
       │                                                                          [outcome=success]
       │  stage switch after grace ─────► CompletedRun[outcome=abandoned, stage=old]
       │  dead-count drop (manual restart) ► CompletedRun[outcome=abandoned] → new run
       │  game exit ≥5s ─────────────────► discard in-flight run (NOT CompletedRun),
       │                                    re-attach, re-fingerprint
       ▼
  RUN_ACTIVE begins at close of the previous run (or on first observed combat after attach):
    baselines captured; stage adopted from the live chain (catalog-gated),
    adoption grace 3 s for auto-replay/advance.
```

Event vocabulary (mirrors the proposed `RunLifecycleEvent` contract in `telemetry-contract.md`):

- `RUN_START` — emitted when baselines are captured (implicit at previous close, or at first
  combat sighting after attach; **late attach ⇒ run flagged `partial-capture`**);
- `RUN_ACTIVE` — state, not event; heartbeats carry live metrics;
- `RUN_CLEAR` — StageClearLog observed (official clear_time read);
- `RUN_FAIL` — StageFailedLog observed (wave progress read);
- `RUN_ABANDON` — stage switch after grace OR dead-count drop OR (defensive) reader detach while
  a run is open in a *supported* degradation mode;
- `RUN_RESTART` — a `RUN_ABANDON` immediately followed by a new run on the **same stage** within a
  short window (derived label for analytics; not a distinct memory event);
- `STAGE_CHANGE` — the catalog-gated stage key changed (informative; feeds abandon detection and
  the Farm view).

Rules TBH Core must keep from the evidence:
1. **Never delay the close** — only the persisted write may wait (pending-close grace) to absorb
   the trailing boss chest.
2. **Identity by timestamp** (run end, ms), never a counter/session (restart-collision bug class).
3. **Cursor seeding on attach** — never replay pre-existing log entries.
4. **Emit every run; classify downstream** — capture quality (`partial`: <95 % of the official
   clear observed, or a success with zero damage), field-level source failures and validity
   evidence are *labels on the record*, not silent drops ("skip ≠ vanish"). Validity is
   evidence-based (telemetry completeness, valid terminal event, supported fingerprint, sane
   stage identity, garbage checks, reconciliation state) — **never a duration floor**: a very
   fast run is at most a diagnostic anomaly, never automatically invalid. The duration floors
   the reference projects use (tbh-meter's 30 s→15 s with the x-10 exemption, tbh-copilot's
   5–900 s window) are their own calibrated product choices, documented in §2 as evidence, not
   adopted by TBH Core (see `farm-analytics.md` §3).
5. **Interrupted runs are discarded**, not recorded (game exit) — but a *closed* pending success
   must be flushed before discarding.
6. **Save-source runs (if ever used while memory is unavailable)** cannot distinguish
   success/fail/abandon and inherit TBH-Optimizer's quantization problems — per the data rules,
   save-derived windows must be labeled `checkpoint` confidence at best and must not enter the
   measured-run analytics pool (see `telemetry-contract.md`).

## 4. NOT TESTED

- No live run capture was executed during this phase; all lifecycle claims come from source
  reading of the referenced projects plus their own committed evidence (tbh-meter's live
  validation output and in-code "proven live" annotations).
- The 1.2.8 dead-count restart detector (`StageManager.DEAD_UNIT_DICT`) is validated by the
  maintainer's live gate only via [stage]/[run-cycle] checks; a deliberate manual-restart test on
  1.2.8 was not observed in the captured evidence.
