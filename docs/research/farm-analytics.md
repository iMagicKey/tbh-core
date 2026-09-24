# Phase A research — farm analytics & recommendation contract

Covers: build fingerprint scope, MVP metric formulas, valid-run requirements, and the
recommendation contract. Evidence anchors: tbh-meter's converter/upstream analytics semantics,
TBH-Optimizer's reconciliation heuristics, TBH-DPS-dashboard's FarmPlanner (measured-vs-estimated
provenance split), tbh-copilot's calibration ladder.

## 1. Build fingerprint

Why: farm statistics are per-build — gear/skill changes materially change XP/h and Gold/h, and
pooling across them contaminates comparisons. Reference practice:
- TBH-DPS fingerprints gear names+affixes+skill identity and **deliberately ignores character and
  skill LEVELS** so ordinary leveling doesn't reset calibration (stale-build flagging instead).
- tbh-meter records the full hero sheet (items with mods, skills with levels, runes) on every run,
  enabling any grouping after the fact.
- TBH-Optimizer stamps stats with hero level and re-projects stale stats via its retention model.

RECOMMENDATION for TBH Core MVP (the fingerprint is an internal analytics boundary; the UI shows
a friendly label, never a giant hash):

- **MUST affect fingerprint** (a change here starts a new sample epoch):
  - party composition (deployed hero keys, from the live HeroList);
  - equipped item identity per hero (itemKey per slot; unknown-slot sentinel counts as its own
    identity);
  - enchant/mod summary per equipped item (statType+tier set — a re-enchanted item is a new build);
  - hero levels (rounded — leveling changes XP retention and clear speed materially; accept the
    TBH-DPS trade-off later if level churn proves too noisy).
- **SHOULD affect fingerprint**:
  - equipped active skills;
  - invested skill-tree summary (per hero total invested levels by key);
  - account-wide rune set summary (key+level).
- **CAN wait until later**:
  - pet; passives detail beyond summary; full inventory/stash state; Steam-market gear variant
    (`…900`) distinctions; difficulty is NOT part of the fingerprint (it's part of the stage key).

Mechanics: compute at run close from the recorded hero sheet; a new fingerprint starts a new
epoch; old runs keep their epoch id and remain browsable; current-build filtering excludes other
epochs from recommendations (they still count for stage-level history views when the user opts
in). Post-MVP option: TBH-Optimizer-style re-projection of old-epoch stats with a visible
`stale` marker.

## 2. MVP metric formulas

Scope: per (build epoch × stage × difficulty) sample.

```
XP per run          = run.xp                                 (memory live; else tagged save)
Gold per run        = run.gold                               (combat gold only — SubKey 1)

Active XP per hour  = SUM(run.xp   over valid runs) / SUM(run.activeSeconds) * 3600
Active Gold/hour    = SUM(run.gold over valid runs) / SUM(run.activeSeconds) * 3600

Session XP per hour     = SUM(valid run.xp  in session) / sessionActiveSeconds * 3600
Session Gold per hour   = SUM(valid run.gold in session) / sessionActiveSeconds * 3600
   where sessionActiveSeconds = SUM of active time across the session's runs + inter-run
   transition time INSIDE the stage loop (auto-replay gaps). Idle time (no run open, game in
   town/menu, reader detached) is excluded by construction — the session clock runs only while
   a run is open or within the auto-replay transition window.

Runs per hour        = COUNT(valid runs) / (SUM(run.activeSeconds) + replayTransitions) * 3600

Mean clear time      = arithmetic mean of duration (success runs)
Median clear time    = median of duration
P90 clear time       = 90th percentile (linear interpolation between order statistics)
Best clear time      = min(duration)
Success rate         = successCount / (successCount + failCount + abandonCount)
                      (each over runs that reached a terminal outcome; partial-capture runs
                      excluded from the denominator's success side per §3)
```

**The weighted-time rule (non-negotiable):** rates are `SUM(values) / SUM(time) * 3600` —
NEVER the arithmetic mean of per-run rates. A 10 s run at 10 k XP/s and a 300 s run at 1 k XP/s
yield 10,300,000 XP per 310 s ≈ 33.1 k XP/min by SUM/SUM, but 330 k XP/min by averaging rates —
an order-of-magnitude fabrication. (Same conclusion independently reached by TBH-DPS's
`Σ(gold_per_sec×duration)/Σ(duration)` fix for save-quantized gold, and the reason
tbh-meter's projected columns derive from stored per-second rates only for SORTING, never
aggregation.)

`run.activeSeconds` = measured duration (baselines→terminal event); when the official
`clear_time` exists and the run is complete, prefer `clear_time` for clear-time statistics and
use measured duration for rates (measured includes post-clear transition the official time
doesn't; document the choice in code).

## 3. Run classification

| Class | Definition | Analytics treatment |
| --- | --- | --- |
| **VALID FARM RUN** | terminal outcome recorded (success), complete capture (not partial), xp/gold fields `ok` (or degraded-but-tagged per rules below), fingerprint recorded, source epoch healthy | counts everywhere |
| **INVALID RUN** | skip rule: `max(measured, clear_time or 0) < 15 AND stageNo != 10` (x-10 exempt); or success with `total_damage <= 0` | recorded ("skip ≠ vanish"), shown greyed, excluded from all aggregates |
| **PARTIAL RUN** | success with `(clear_time >= 30 AND measured < 0.95 · clear_time)` — the app joined mid-run; undercounted | recorded, flagged, excluded from aggregates (may count for drop tallies) |
| **CONFLICTED RUN** | reconciliation verdict `conflict` unresolved (memory vs aligned fresh checkpoint beyond calibrated tolerance) | recorded, flagged, excluded from recommendations until resolved |
| DEGRADED RUN (adjacent concept) | a metric's source failed (`heroes:err`, gold/xp err envelope) or reader was in `degraded` health at capture | metric-specific exclusion (e.g. gold excluded from gold aggregates; duration/outcome may still count if their sources were healthy) — per-field, never whole-run silent drops |

Fail and abandoned runs: recorded with full metrics; counted in success rate and (for `fail`)
optionally in diagnostic views; not part of XP/Gold per-run averages (a fail's gold/xp are real
but averaging them into "farm stage" numbers would misrepresent the farm loop — success runs
define the farming economics; revisit with data).

## 4. Recommendation contract

Product rule (confirmed as the current rule):

- `< 3` successful valid runs on a (stage × difficulty × build epoch): **Insufficient** — no
  recommendation, show "need more runs";
- `3–9`: **Low confidence** — visible as candidate, not a normal recommendation;
- `10–19`: **Medium confidence** — eligible recommendation;
- `20+`: **High confidence**.

**A stage does not become a normal recommendation before ≥10 successful valid runs.**

Recommendations:

- **Best XP stage** = argmax(Active XP/hour) among eligible samples (≥10 runs);
- **Best Gold stage** = argmax(Active Gold/hour) among eligible;
- **Best balanced stage** = normalize XP/h and Gold/h within the eligible set (min-max or
  per-metric z-score — pick one, document it) and argmax the mean of normalized scores, shown
  with both underlying rates (a balanced pick must never display a single blended number without
  its parts).

### Should success rate or variance lower confidence even with sufficient run count? (analysis)

- **Success rate**: yes, as a gate rather than a dial. A stage farmed at <100 % success mixes
  failed attempts into the *time base* (a fail consumes time that SUM/SUM correctly attributes),
  so Active XP/h already prices failures in. But a very low success rate (<50 %) on a
  "recommended" stage deserves a visible warning and, below a floor (MVP: <30 %), demotion by one
  confidence tier — the user experience of a "best" stage that usually fails is bad even when the
  math is honest. Thresholds to be calibrated with real data (no repo evidence pins a number).
- **Sample variance**: yes, bounded — require the recommendation's rate to be statistically
  usable: MVP rule of thumb — if the P90/P50 clear-time ratio exceeds ~2, or the XP/run
  coefficient of variation exceeds ~0.5, cap confidence at Medium (never promote to High on
  unstable samples). Exact cutoffs are empirical; ship them as constants flagged for calibration,
  not as silent magic.

No predictive unknown-stage models in MVP (explicitly out of scope; post-MVP features must keep
the `estimated` label per the data rules).
