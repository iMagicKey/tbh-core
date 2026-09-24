# Agent instructions for TBH Core

## Mission

Build TBH Core as a trustworthy, local-first Task Bar Hero telemetry and farming analytics application.

The primary product outcome is reliable measured run statistics and best-farm recommendations.

## Hard safety boundaries

Never introduce functionality that:

- writes to Task Bar Hero process memory;
- calls `WriteProcessMemory` or injects code/DLLs into the game;
- modifies Task Bar Hero files;
- modifies `SaveFile_Live.es3`;
- modifies `Player.log`;
- requires administrator privileges for normal operation without an approved architecture change.

All game integrations are read-only.

## Data rules

1. Measured data wins over modeled data.
2. A value derived from a fallback source must retain provenance.
3. Estimated data must never be displayed as measured data.
4. Unsupported game versions must fail safe, not emit plausible-looking garbage.
5. Save data is a checkpoint source, not automatically a per-run telemetry source.
6. Memory data is only authoritative while compatibility and reader-health checks pass.
7. Player.log is supplementary event telemetry unless evidence establishes stronger guarantees.

## Scope discipline

- Work in small focused changes.
- Do not combine unrelated refactors with feature work.
- Do not rewrite stable modules just to change style.
- Add tests for calculation/parsing/reconciliation logic.
- Preserve data migration paths once persistent user data exists.

## Reference projects

See `docs/REFERENCE_PROJECTS.md`.

Reference projects may be studied for behavior, architecture, data structures, and UX ideas.
Do not copy code or assets until the source license and attribution requirements have been reviewed for the exact material being reused.

## Mandatory handoff report

Every agent completing an implementation task must return:

1. Base commit SHA and final commit SHA.
2. Files changed and why.
3. Architecture/data-flow changes.
4. Commands run and exact results.
5. Manual validation actually performed.
6. `NOT TESTED` items with reason and exact validation steps.
7. Known limitations and risks.
8. Any new network/file/process permissions introduced.
9. Data schema/migration impact.
10. Recommended next task.

Never describe unexecuted validation as "working" or "should work".
