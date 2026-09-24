# TBH Core

Open-source Windows companion for **Task Bar Hero** focused on trustworthy run telemetry, farming analytics, and recommendations.

> TBH Core is an independent community project and is not affiliated with or endorsed by the developers or publishers of Task Bar Hero.

## Product goal

TBH Core answers three questions with measured data whenever possible:

1. What did this run actually yield?
2. What are my real XP/hour and Gold/hour rates?
3. Which stage is the best measured farm for my current build?

## MVP principles

- Windows 10/11 x64 first.
- Electron + React + TypeScript + Tailwind CSS.
- One main window with `Live`, `Farm`, `Runs`, and `Compare` sections.
- Read-only access to all game data sources.
- Multi-source verification using `SaveFile_Live.es3`, read-only process memory, and `Player.log` where useful.
- Measured data is never silently replaced with estimated data.
- Local-first SQLite persistence (planned in Phase 2).
- No accounts and no analytics telemetry.
- GitHub Releases for stable/beta updates.

## Current status

Bootstrap / pre-MVP. The UI shell and analytics contracts are present; Task Bar Hero data-source integrations are intentionally not implemented yet.

## Development

Requirements:

- Node.js 24+
- pnpm 12+
- Windows 10/11 is required for end-to-end game integration tests

```bash
pnpm install
pnpm dev
```

Checks:

```bash
pnpm check
```

Windows installer:

```bash
pnpm dist:win
```

## Security boundary

TBH Core must never:

- write to Task Bar Hero process memory;
- inject DLLs or code into the game;
- modify game files;
- modify `SaveFile_Live.es3`;
- modify `Player.log`;
- require administrator privileges under normal operation.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Game assets

Game sprites, icons, and other copyrighted assets are **not distributed in this repository**. Generic project-owned UI assets are used until a legally safe asset strategy is established.

## License

MIT. See [LICENSE](LICENSE).
