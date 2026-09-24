# Phase A research — farm analytics & recommendation contract

Covers: the two performance concepts (success-run performance vs farm economics), user-facing
rate definitions (active vs session), run validity and inclusion, success rate, the
recommendation contract, and build-fingerprint scope. Evidence anchors: tbh-meter's
converter/upstream analytics semantics, TBH-Optimizer's reconciliation heuristics,
TBH-DPS-dashboard's FarmPlanner (measured-vs-estimated provenance split), tbh-copilot's
calibration ladder. Revised in the Phase A review pass (2026-09-24) — see §7 for what changed.

## 1. Two performance concepts (never conflate them)

### A) SUCCESS-RUN PERFORMANCE — diagnostic statistics over successful clears only

Answers "what does one clean clear of this stage look like?":

```
XP per successful run
Gold per successful run
Mean successful clear time
Median successful clear time
P90 successful clear time   (linear interpolation between order statistics)
Best successful clear time  (min)
```

Scope: successful valid attempts only. Useful for expectations and diagnostics; **never** the
basis for stage comparison or recommendations.

### B) FARM ECONOMICS — what farming this stage actually yields per unit of invested time

Used for: Active XP/hour, Active Gold/hour, Runs/hour, and stage recommendations.

```
Farm XP/hour   = SUM(xp   over eligible farm attempts) / SUM(farming-attempt seconds) * 3600
Farm Gold/hour = SUM(gold over eligible farm attempts) / SUM(farming-attempt seconds) * 3600
Runs/hour      = COUNT(terminal legitimate attempts)   / SUM(farming-attempt seconds) * 3600
```

- The **denominator** must include time consumed by ALL legitimate farming attempts: successes,
  fails, and abandoned/restarted attempts that consumed farming time.
- The **numerator** includes the ACTUAL measured XP/Gold earned during those attempts. A failed
  attempt is NOT assumed to yield zero — if telemetry measured reward during it, that reward
  counts (and if it measured none, zero is the measured value).
- An "eligible farm attempt" = a legitimate terminal attempt with reliable telemetry (§3).

Motivating example (the inconsistency this corrects):

```
success: 20 s, 100 XP
fail:    40 s,   0 XP

Farm XP rate = 100 XP / 60 s          ✅ actual farming efficiency
NOT          = 100 XP / 20 s          ❌ success-only aggregation — 3× overestimate
```

The harder the stage, the larger the success-only bias — difficult stages would be
systematically over-recommended.

### Abandon/restart time treatment (explicit)

- An abandoned or restarted attempt consumed real farming time → it MUST appear in the
  denominator, with its measured XP/Gold in the numerator.
- The auto-replay transition after a clear is part of the farming loop: it is included in
  SESSION time (§2B); for the ACTIVE farm rate it is not attempt time (the attempt ends at its
  terminal event) — the two rate concepts below define exactly where it lands.
- A stage switch away from an unfinished run closes the attempt as `abandoned`; the time up to
  the switch counts as attempt time.
- **A telemetry artifact is NOT a failed attempt.** Partial captures, reader-corrupted periods
  and unsupported-fingerprint captures are excluded from both numerator and denominator because
  their DATA is unreliable. A legitimate fail never disappears from the time cost of farming; a
  broken measurement never enters the economics.

### The weighted-time rule (non-negotiable)

Rates are `SUM(values) / SUM(time) * 3600` — NEVER the arithmetic mean of per-run rates. A 10 s
run at 10 k XP/s and a 300 s run at 1 k XP/s yield ≈ 33.1 k XP/min by SUM/SUM but 330 k XP/min
by averaging rates — an order-of-magnitude fabrication. (Same conclusion independently reached
by TBH-DPS's `Σ(gold_per_sec×duration)/Σ(duration)` fix for save-quantized gold.)

## 2. User-facing rate concepts

### A) ACTIVE FARM RATE — "Active XP/hour", "Active Gold/hour"

Purpose: how efficient is the actual stage gameplay?

- Denominator: time consumed by the farming attempts themselves — success + fail + legitimate
  abandon/restart attempt time.
- Excludes: telemetry partial captures, unsupported-reader periods, unrelated menu/AFK time.
- This is the farm economics of §1 and the **primary metric for comparing stages**.

### B) SESSION RATE — "Session XP/hour", "Session Gold/hour"

Purpose: how much did the user actually earn per real elapsed hour of this farming session?

```
Session XP/hour   = SUM(xp   of accepted attempts in session) / sessionWallClockSeconds * 3600
Session Gold/hour = SUM(gold of accepted attempts in session) / sessionWallClockSeconds * 3600
```

Session model (MVP — deliberately simple, no AFK heuristics):

- **Session starts** at the START of the first accepted farming attempt (there is no session
  before farming begins).
- **Session ends** when no new attempt opens after the last accepted attempt's terminal event
  (the current open attempt extends the session while it runs).
- The denominator is the wall-clock span from that first attempt start to the last/current
  accepted attempt end, **including**: loading screens, auto-replay transitions, manual delays
  between attempts, and menu time occurring inside that span.
- **Excluded from the span**: time while the game is closed, extended telemetry-disconnected
  periods (no farming session is considered active), and anything before the first or after the
  last accepted attempt.
- An explicit user "new session" cut may split a session (tbh-meter app precedent: stored as
  metadata; runs are never silently re-attributed).

A possible future third metric — excluding AFK but including replay transitions — would be added
under an explicit name such as "Loop XP/hour". NOT in MVP.

### Run timing

- attempt start = baselines captured (`RUN_START`); attempt end = terminal event
  (`RUN_CLEAR`/`RUN_FAIL`/`RUN_ABANDON`); `durationMs` = end − start.
- When the official `clear_time` exists and capture is complete: use it for SUCCESS-RUN
  clear-time statistics (§1A); use measured duration for rate denominators (measured includes
  the post-clear transition the official time does not; the choice is documented in code).

## 3. Run validity and inclusion

Validity is **evidence-based, never duration-based**.

A run is a VALID (legitimate attempt, reliable telemetry) when:

- lifecycle integrity: baselines captured + a valid terminal event closed the attempt;
- telemetry completeness: not a partial capture;
- supported game fingerprint and healthy source epoch at capture time;
- sane stage identity (catalog-resolved stage key);
- values pass garbage checks (monotonic cumulative deltas, XP oracle, envelope ok);
- no unresolved reconciliation conflict.

A run is a TELEMETRY ARTIFACT (stored, visible, excluded from economics) when it is:

- a partial capture (app joined mid-run: <95 % of the official clear observed, or a success
  with zero measured damage);
- reader-corrupted / source-degraded for the fields in question (field-level exclusion where
  the failure is field-specific);
- captured under an unsupported game version;
- unresolved in reconciliation (`conflict`);
- carrying impossible/garbage values that failed the checks above.

**Duration is NOT a validity condition.** A very fast run may raise a diagnostic anomaly (e.g.
"clear time below this stage's observed minimum") but stays valid unless evidence invalidates
it. The reference projects' duration floors (tbh-meter's 30 s→converter-15 s with the x-10
exemption; tbh-copilot's 5–900 s plausibility window) are *their* calibrated product choices
against *their* data — TBH Core adopts none generically. If stage-specific
impossible-duration evidence accumulates from our own measurements, it becomes a future
**calibrated** validation rule (per-stage, empirically derived, documented separately) — nothing
is invented now.

"Skip ≠ vanish" (kept from tbh-meter): every closed attempt is stored and shown — greyed when
excluded — nothing silently disappears.

### Run inclusion matrix

| Run type | Stored | Success-run performance (§1A) | Farm economics (rates / recommendations) | Recommendation sample count |
| --- | --- | --- | --- | --- |
| success, complete capture, valid | yes | included | numerator + denominator | **counts** toward 3/10/20 |
| fail (legitimate attempt, valid telemetry) | yes | no | numerator (measured rewards) + **denominator** | no (not a successful clear) |
| abandon/restart (consumed farming time) | yes | no | numerator (measured rewards) + **denominator** | no |
| partial capture | yes (flagged) | no | excluded — unreliable data | no |
| conflicted (unresolved) | yes (flagged) | no | excluded until resolved | no |
| unsupported-reader capture | yes (flagged) | no | excluded | no |

Success rate and sample counting use the same legitimacy boundary (§4, §5).

## 4. Success rate

```
success rate = successful legitimate attempts
             / all legitimate terminal farming attempts
```

- Included in the denominator: success, fail, and abandon/restart **when the attempt genuinely
  occurred** (valid telemetry per §3).
- Excluded from both numerator and denominator: partial-capture telemetry artifacts,
  reader-corrupted runs, unsupported-game telemetry, duplicates.

MVP exposes the success rate plainly. Failed-attempt time is already priced into Farm
XP/hour / Gold/hour (§1), so **no additional confidence penalty is applied**. Empirically
calibrated low-success-rate adjustments are a possible post-MVP research idea — explicitly not
normative now.

## 5. Recommendation contract

Base sample-confidence thresholds (retained), counted on **successful valid clears**:

- `< 3` successful valid clears: **Insufficient** — no recommendation, show "need more runs";
- `3–9`: **Low confidence** — visible as a candidate, not a normal recommendation;
- `10–19`: **Medium confidence** — eligible recommendation;
- `20+`: **High confidence**.

**A stage does not become a normal recommendation before ≥10 successful valid clears.**

**SAMPLE CONFIDENCE ≠ FARM ECONOMIC RATE** (explicit): the 3/10/20 counts gate eligibility;
the rates that RANK eligible stages come from farm economics (§1), whose denominator includes
the failed and abandoned attempts of the same comparable sample period and build epoch. Failed
attempts never vanish from the economic rate; they simply do not advance the sample count.

Recommendations:

- **Best XP stage** = argmax(Active XP/hour) among eligible samples (≥10 successful valid
  clears);
- **Best Gold stage** = argmax(Active Gold/hour) among eligible;
- **Best balanced stage** = mean of min-max-normalized XP/h and Gold/h within the eligible set,
  always displayed with both underlying rates (never a single blended number alone).

MVP confidence inputs: successful sample count; data/source quality (source-health epoch,
field-level ok/err envelopes); conflict state; supported reader health. Variance (P90/P50
spread, coefficient of variation) may be **displayed** in diagnostics without silently changing
recommendation confidence. Numeric variance thresholds (e.g. P90/P50 > 2 or CV > 0.5 cutoffs
drafted in the first revision of this document) are **not** normative MVP behavior — they move
to future empirical calibration unless direct observed-game evidence supports exact values.

Scope: recommendations are per (build epoch × stage × difficulty). No predictive unknown-stage
models in MVP; post-MVP estimates must keep the `estimated` label per the data rules.

## 6. Build fingerprint

Why: farm statistics are per-build — gear/skill changes materially change XP/h and Gold/h, and
pooling across them contaminates comparisons. Reference practice: TBH-DPS fingerprints gear
names+affixes+skill identity and **deliberately ignores character and skill LEVELS** so ordinary
leveling doesn't reset calibration; tbh-meter records the full hero sheet on every run so any
grouping is possible after the fact.

**MUST affect fingerprint** (a change starts a new sample epoch):

- deployed party composition (hero keys from the live HeroList);
- equipped item identity per relevant slot (itemKey per slot; unknown-slot sentinel is its own
  identity);
- equipment enchant/mod identity (statType+tier set — a re-enchanted item is a new build);
- equipped active skills — when reliably observable;
- skill-tree configuration — when reliably observable;
- rune configuration — when it materially changes combat/farming performance AND is reliably
  observable.

**Context only (stored, never hashed into `buildFingerprintId`):**

- hero levels: stored on every CompletedRun, included in build context, surfaced as level
  range / start-end level in diagnostics. Ordinary leveling during farming must NOT start a new
  epoch — otherwise long sessions continually fragment samples and stages may never reach
  medium/high confidence. Future analytics may use level as a covariate, or introduce explicit
  performance epochs if real measurements show meaningful drift — do not over-engineer now.

**Later:**

- pet; passive detail beyond the tree summary; full inventory/stash state; Steam-market gear
  variants (`…900`); difficulty/stage remain OUTSIDE the fingerprint — they are analytics
  dimensions.

Mechanics: compute at run close from the recorded hero sheet; a new fingerprint starts a new
epoch; old runs keep their epoch id and remain browsable; current-build filtering excludes
other epochs from recommendations (opt-in for history views). Post-MVP option:
TBH-Optimizer-style re-projection of old-epoch stats with a visible `stale` marker.

## 7. Revision note (review pass, 2026-09-24)

Corrected during Phase A review: (1) farm economics now include failed/abandoned attempt time
(previously rates were described mainly over successful runs — difficult stages would be
overestimated); (2) the arbitrary `<15 s → invalid` rule removed — validity is evidence-based;
(3) Active vs Session rates redefined (Session = wall-clock session span including transitions
and menus, not "active + transitions"); (4) hero levels moved out of the fingerprint MUST list
into run context; (5) variance thresholds and low-success demotion demoted to future empirical
calibration.
