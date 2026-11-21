"""Read-only security tests: static forbidden-symbol scan + access mask."""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import tbh_core_reader.win32 as win32  # noqa: E402

SRC_ROOT = os.path.join(os.path.dirname(__file__), "..", "src", "tbh_core_reader")

FORBIDDEN = [
    "WriteProcessMemory",
    "PROCESS_VM_WRITE",
    "PROCESS_VM_OPERATION",
    "PROCESS_ALL_ACCESS",
    "VirtualAllocEx",
    "VirtualProtectEx",
    "CreateRemoteThread",
    "SetThreadContext",
    "LoadLibraryA",
    "LoadLibraryW",
]


class ReadOnlyTests(unittest.TestCase):
    def test_forbidden_symbols_absent_from_production_source(self):
        violations = []
        for dirpath, _dirnames, filenames in os.walk(SRC_ROOT):
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                for symbol in FORBIDDEN:
                    if re.search(r"\b%s\b" % re.escape(symbol), text):
                        violations.append("%s: %s" % (name, symbol))
        self.assertEqual(violations, [], "forbidden APIs found: %r" % violations)

    def test_open_process_uses_read_only_mask(self):
        # QUERY_INFORMATION | VM_READ only — nothing else
        self.assertEqual(win32.READ_FLAGS,
                         win32.PROCESS_QUERY_INFORMATION | win32.PROCESS_VM_READ)
        self.assertNotIn(0x0008, [win32.READ_FLAGS & 0xFFFF])  # VM_OPERATION bit not set
        self.assertEqual(win32.READ_FLAGS & 0x0008, 0)   # PROCESS_VM_OPERATION
        self.assertEqual(win32.READ_FLAGS & 0x0020, 0)   # PROCESS_VM_WRITE

    def test_read_is_the_only_memory_api_declared(self):
        with open(os.path.join(SRC_ROOT, "win32.py"), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("ReadProcessMemory", text)
        # no other process-memory write entry points declared in the ctypes bindings
        for api in ("WriteProcessMemory", "VirtualAllocEx", "VirtualProtectEx",
                    "CreateRemoteThread"):
            self.assertNotIn(api, text)


if __name__ == "__main__":
    unittest.main()
