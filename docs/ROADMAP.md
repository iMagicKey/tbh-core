# TBH Core roadmap

## Phase 0 — Reference research and contracts

- Audit relevant TBH community repositories and their licenses.
- Document save schema/decryption approaches.
- Document memory-reader approaches and run lifecycle.
- Document useful `Player.log` events.
- Define canonical run and observation contracts.

## Phase 1 — Application bootstrap

- Electron + React + TypeScript + Tailwind.
- Single-window shell.
- RU/EN localization foundation.
- CI and release packaging.
- Diagnostics shell.

## Phase 2 — Save checkpoint source

- Locate TBH installation/save.
- Manual path fallback.
- Read-only ES3 decrypt/parse/watch.
- Player-state checkpoint model.
- Persistence layer and schema migrations.

## Phase 3 — Read-only memory source

- Process detection.
- Game-version compatibility fingerprint.
- Read-only live telemetry.
- Exact run lifecycle capture.
- Health/unsupported-version states.

## Phase 4 — Reconciliation

- Multi-source observations.
- Conflict/drift detection.
- Capture-quality scoring.
- Safe degradation when memory support breaks.

## Phase 5 — Run history

- Persist completed runs.
- Filters/details.
- CSV/JSON export.
- Session persistence.

## Phase 6 — Farm analytics

- XP/run and Gold/run.
- Active and session XP/hour and Gold/hour.
- runs/hour.
- average, median, P90, best clear time.
- success rate.

## Phase 7 — Recommendations

- Best measured XP stage.
- Best measured Gold stage.
- Confidence based on sample quality/size.
- No unknown-stage prediction in MVP.

## Phase 8 — Build fingerprints and compare

- Detect material build changes.
- Keep farm samples separated by build epoch.
- Stage/build comparison UI.

## Phase 9 — Compact mode and hardening

- Always-on-top compact mode.
- Windows DPI/multi-monitor testing.
- Crash recovery.
- Game-update regression fixtures.

## Post-MVP

- Player.log chest tracking.
- Inventory/loot tooling.
- Steam Market integration (opt-in network access).
- More advanced recommendations/estimates, always visibly separated from measured data.
