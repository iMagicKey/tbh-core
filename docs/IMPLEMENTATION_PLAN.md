# TBH Core implementation plan

## Product target

A fast Windows-first MVP that measures real Task Bar Hero farming performance and recommends the best measured stage for XP and Gold.

The product is successful when the user can farm two or more stages and trust the comparison without needing a spreadsheet.

---

## Milestone A — Research contracts

### Goal

Establish what can be reliably obtained from each source before implementing integrations.

### Deliverables

- reference-repository audit;
- license audit;
- canonical `Observation`, `CompletedRun`, `BuildSnapshot`, `SourceHealth` contracts;
- save-file schema/decryption notes;
- memory telemetry inventory;
- game-version compatibility strategy;
- `Player.log` event inventory;
- fixture strategy.

### Exit criteria

No production parser/reader begins until the expected source semantics and failure modes are documented.

---

## Milestone B — Application foundation

### Goal

Stable single-window application shell and development/release workflow.

### Deliverables

- Electron + React + TS + Tailwind;
- single `BrowserWindow`;
- Live/Farm/Runs/Compare navigation;
- RU/EN localization foundation;
- settings and diagnostics model;
- CI checks;
- Windows NSIS packaging;
- stable/beta GitHub Release strategy;
- manual update-check UI contract.

### Exit criteria

A clean checkout builds and tests on GitHub Actions and produces a Windows installer from a release tag.

---

## Milestone C — Save checkpoint source

### Goal

Create the first robust real-game source without depending on memory offsets.

### Deliverables

- Steam/TBH save auto-discovery;
- manual path fallback;
- read-only ES3 decode/parse;
- directory watcher resilient to atomic replace;
- schema validation;
- current player-state snapshot;
- source health/staleness reporting;
- redacted diagnostic export.

### Exit criteria

Repeated saves update state without modifying the source file and fixtures cover known schema variants.

---

## Milestone D — Persistence

### Goal

Make telemetry durable before high-frequency memory capture arrives.

### Deliverables

- SQLite database;
- schema migrations;
- sessions;
- runs;
- build snapshots/fingerprints;
- source-health history where useful;
- CSV/JSON export contracts.

### Exit criteria

Application restart preserves historical data and migration tests pass.

---

## Milestone E — Memory run source

### Goal

Obtain exact live/per-run telemetry with a strict read-only boundary.

### Deliverables

- process discovery;
- game version/fingerprint detection;
- memory compatibility table;
- health states: disconnected / healthy / degraded / unsupported;
- run start/end/outcome;
- stage/difficulty;
- timer;
- XP and combat Gold where verified;
- DPS/damage/mobs where verified;
- restart/reconnect handling.

### Exit criteria

A validation matrix demonstrates correct capture for clear/fail/abandon/restart on a supported TBH build.

---

## Milestone F — Reconciliation

### Goal

Make multiple sources increase trust rather than produce silent contradictions.

### Deliverables

- observation provenance;
- cross-source checkpoint verification;
- stale/conflict detection;
- capture-quality score;
- safe fallback rules;
- visible diagnostics.

### Exit criteria

Conflicting sources are surfaced and questionable runs cannot silently influence high-confidence recommendations.

---

## Milestone G — Farm analytics MVP

### Goal

Deliver the core user value.

### Metrics

Per run:

- duration;
- outcome;
- XP;
- Gold;
- DPS/damage/mobs when available;
- build association.

Per stage/build sample:

- run count;
- success rate;
- total XP/Gold;
- XP/run and Gold/run;
- Active XP/h and Active Gold/h;
- Session XP/h and Session Gold/h;
- runs/hour;
- average clear;
- median clear;
- P90 clear;
- best clear.

### Formula rule

Rates are based on totals over total time, not the arithmetic mean of individual run rates.

### Exit criteria

Two measured stages can be compared with repeatable results and tests cover all rate formulas.

---

## Milestone H — Recommendations and build separation

### Goal

Recommend the best farm without contaminating samples from materially different builds.

### Deliverables

- build fingerprint/epoch;
- current-build filtering;
- best measured XP stage;
- best measured Gold stage;
- basic balanced recommendation if useful;
- sample confidence;
- recommendation threshold: 10 successful runs by default.

Suggested confidence UI:

- fewer than 3 runs: insufficient;
- 3–9: low;
- 10–19: medium;
- 20+: high.

### Exit criteria

Changing a material build component starts/separates the relevant farm sample and old runs remain browsable.

---

## Milestone I — UX hardening / compact mode

### Deliverables

- compact mode of the same application window;
- optional always-on-top;
- clear source-health indicators without overwhelming the main UI;
- Windows DPI and multi-monitor validation;
- renderer crash recovery strategy;
- performance profiling.

---

## Post-MVP

Deferred until measured farming analytics is stable:

- chest cooldown/rotation;
- full inventory browser;
- loot finder;
- Steam Market pricing;
- rune/gear optimization;
- estimated unmeasured stages;
- cloud/account/leaderboard functionality.

Any future estimates must remain visibly distinct from measured results.
