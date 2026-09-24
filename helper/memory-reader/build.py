"""build.py — reproducible PyInstaller (onedir) build of the memory reader helper.

Creates an isolated build venv (.build-venv), installs the pinned build
dependencies, and produces dist/tbh-core-reader/ (a self-contained directory;
end users need NO Python). Bundles profiles/ next to the executable via
--add-data so the 1.2.8 profile ships inside the build.

Usage: python build.py [--python <path-to-python>]
Documented environment: Python 3.11.9 x64, PyInstaller 6.10.0 (pinned above).
"""

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(ROOT, ".build-venv")
DIST = os.path.join(ROOT, "dist", "tbh-core-reader")


def run(cmd, **kwargs):
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kwargs)


def main():
    python = sys.executable
    if not os.path.isdir(os.path.join(VENV, "Scripts")):
        run([python, "-m", "venv", VENV])
    vpython = os.path.join(VENV, "Scripts", "python.exe")
    run([vpython, "-m", "pip", "install", "--disable-pip-version-check", "-q",
         "-r", os.path.join(ROOT, "requirements-build.txt")])

    if os.path.isdir(os.path.join(ROOT, "dist")):
        shutil.rmtree(os.path.join(ROOT, "dist"), ignore_errors=True)

    run([vpython, "-m", "PyInstaller",
         "--noconfirm",
         "--clean",
         "--name", "tbh-core-reader",
         "--onedir",
         # console build: stdout carries the JSONL protocol (spawned hidden by Electron)
         "--console",
         "--paths", os.path.join(ROOT, "src"),
         "--add-data", os.path.join(ROOT, "profiles") + os.pathsep + "profiles",
         "--distpath", os.path.join(ROOT, "dist"),
         "--workpath", os.path.join(ROOT, "build"),
         "--specpath", ROOT,
         os.path.join(ROOT, "src", "reader_entry.py")])

    exe = os.path.join(DIST, "tbh-core-reader.exe")
    if not os.path.isfile(exe):
        print("BUILD FAILED: expected", exe)
        return 1
    print("BUILD OK:", exe)
    return 0


if __name__ == "__main__":
    sys.exit(main())
