"""PyInstaller entry point: keeps the tbh_core_reader package context intact
(running __main__.py directly breaks its relative imports)."""

import sys

from tbh_core_reader.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
