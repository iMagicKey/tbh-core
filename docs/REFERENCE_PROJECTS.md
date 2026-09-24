# Reference projects

These repositories are research inputs, not upstream dependencies by default.

> Phase A (2026-09-24) audited all of them at source level — per-repo matrix in
> [`research/reference-matrix.md`](research/reference-matrix.md), licensing in
> [`research/license-audit.md`](research/license-audit.md). Notable audit outcomes:
> `tbh-companion` declares MIT only in `app/package.json` and ships no LICENSE file;
> `tbh-codown` has no license at all — both are study-only. `WarmBed/TBH-DPS-dashboard`
> is a BepInEx in-process mod (its data knowledge transfers; its architecture never does).

## mad-labs-org/tbh-meter

Research targets:

- external read-only process-memory telemetry;
- run lifecycle detection;
- compatibility/calibration methodology;
- live DPS, XP and Gold capture;
- Windows overlay lessons and failure modes.

## lucasfevi/tbh-companion

Research targets:

- Electron UX patterns;
- save watching;
- session/rolling XP and Gold rates;
- local persistence and compact presentation.

## WarmBed/TBH-DPS-dashboard

Research targets:

- stage comparison;
- build-aware farming analytics;
- build fingerprint concepts;
- measured-vs-estimated farming planner UX.

Do not adopt injection/mod architecture merely because the project uses it.
TBH Core's integration boundary remains external and read-only.

## Rupelio/TBH-Optimizer

Research targets:

- save-based farm measurement;
- stage ranking;
- file-watch robustness;
- smoothing/confidence concepts.

## shigake/tbh-copilot

Research targets:

- save decoding and player-state modeling;
- farming UX and stage-data presentation;
- inventory/rune concepts for post-MVP.

Do not treat modeled stage estimates as ground truth.

## feroddev/tbh-codown

Research targets:

- `Player.log` monitoring;
- chest event detection;
- cooldown/route concepts for post-MVP.

## lezards/giba-steam-market

Research targets:

- ES3/save discovery and decoding strategies;
- item mapping concepts;
- optional post-MVP market integration.

## License rule

Before reusing source code, bundled data, or assets from any reference repository:

1. identify the exact repository/file license;
2. confirm compatibility with TBH Core's MIT license;
3. preserve required copyright/attribution notices;
4. record the decision in a dependency/attribution document.

Behavioral ideas and independently reimplemented algorithms should still be documented when a reference project materially influenced the design.
