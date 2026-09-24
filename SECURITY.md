# Security policy

## Trust model

TBH Core is designed as a local, read-only companion application.

The project may read from:

- Task Bar Hero process memory via read-only Windows APIs;
- `SaveFile_Live.es3`;
- `Player.log`;
- local TBH installation metadata needed for compatibility detection.

It must not write to or modify any of those sources.

## Network policy

The baseline application performs no analytics or account telemetry.
Network access is limited to functionality explicitly documented by the project, beginning with GitHub release update checks.

## Reporting vulnerabilities

Please open a GitHub security advisory if available. If the repository does not yet have private vulnerability reporting enabled, open an issue that contains no exploit secrets and request a private contact path.

## High-risk changes

Pull requests that add any of the following require explicit maintainer review and dedicated tests:

- process-memory access;
- native modules/helpers;
- update/install logic;
- save decryption/parsing;
- network destinations;
- privilege elevation;
- code execution outside the packaged application.
