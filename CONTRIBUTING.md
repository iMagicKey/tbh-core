# Contributing

TBH Core is developed in small, reviewable phases.

## Workflow

1. Create a focused feature branch.
2. Keep unrelated refactors out of the PR.
3. Add or update tests for new behavior.
4. Run `pnpm check` before opening a PR.
5. Describe anything that was **not tested** rather than claiming it should work.

## Non-negotiable integration rules

- Read-only game process access only.
- No DLL injection.
- No `WriteProcessMemory`.
- No game-file modification.
- No save/log modification.
- No silent fallback from measured to estimated values.
- Unsupported game versions must degrade safely.

## Agent handoff format

Automated coding agents should include in their final report:

- base and final commit SHA;
- files changed;
- architecture/data-flow changes;
- commands run and results;
- manual validation actually performed;
- NOT TESTED items and exact reproduction commands;
- known limitations and risks;
- recommended next step.
