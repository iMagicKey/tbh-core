"""win32.py — READ-ONLY process access (kernel32 via ctypes).

Adapted from tbh-meter (MIT). INVARIANT: OpenProcess is called ONLY with
PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, and ReadProcessMemory is the only
memory API used anywhere. tests/test_readonly.py statically scans for forbidden
symbols and asserts the access mask.
"""

import ctypes
import struct
import time
from ctypes import wintypes

TH32CS_SNAPPROCESS = 0x2
TH32CS_SNAPMODULE = 0x8
TH32CS_SNAPMODULE32 = 0x10
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010  # the ONLY VM flag we ever request
READ_FLAGS = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
INVALID_HANDLE = 0xFFFFFFFFFFFFFFFF
MAX_PATH = 260
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
READABLE = 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * MAX_PATH)]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
                ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.c_void_p),
                ("modBaseSize", wintypes.DWORD), ("hModule", wintypes.HMODULE),
                ("szModule", ctypes.c_char * 256), ("szExePath", ctypes.c_char * MAX_PATH)]


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", wintypes.DWORD), ("PartitionId", wintypes.WORD),
                ("__pad", wintypes.WORD), ("RegionSize", ctypes.c_size_t),
                ("State", wintypes.DWORD), ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD)]


_K = None


def _kernel32():
    global _K
    if _K is not None:
        return _K
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k.Process32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k.VirtualQueryEx.restype = ctypes.c_size_t
    k.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.QueryFullProcessImageNameW.restype = wintypes.BOOL
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                             ctypes.POINTER(wintypes.DWORD)]
    _K = k
    return k


def find_pid(name):
    nm = (name or "TaskBarHero.exe").encode()
    k = _kernel32()
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE:
        return None
    try:
        e = PROCESSENTRY32()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = k.Process32First(snap, ctypes.byref(e))
        while ok:
            if e.szExeFile.lower() == nm.lower():
                return e.th32ProcessID
            ok = k.Process32Next(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return None


def open_process(pid):
    """READ-ONLY handle — the ONE audited attach point."""
    return _kernel32().OpenProcess(READ_FLAGS, False, pid)


def close(handle):
    if handle:
        try:
            _kernel32().CloseHandle(handle)
        except Exception:
            pass


def process_image_path(handle):
    size = wintypes.DWORD(MAX_PATH * 4)
    buf = ctypes.create_unicode_buffer(size.value)
    if not _kernel32().QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
        return None
    return buf.value or None


def module_base(pid, name):
    nm = (name or "GameAssembly.dll").encode()
    k = _kernel32()
    for _ in range(4):
        snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if snap and snap != INVALID_HANDLE:
            try:
                me = MODULEENTRY32()
                me.dwSize = ctypes.sizeof(MODULEENTRY32)
                ok = k.Module32First(snap, ctypes.byref(me))
                while ok:
                    if me.szModule.lower() == nm.lower():
                        return int(me.modBaseAddr), int(me.modBaseSize)
                    ok = k.Module32Next(snap, ctypes.byref(me))
            finally:
                k.CloseHandle(snap)
            return None, None
        time.sleep(0.05)
    return None, None


def regions(handle, protect_mask=READABLE):
    """[(base, size)] of committed regions matching the protection mask."""
    res = []
    mbi = MBI()
    k = _kernel32()
    addr = 0
    while addr < 0x7FFFFFFFFFFF:
        if not k.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & protect_mask) and not (mbi.Protect & PAGE_GUARD):
            res.append((mbi.BaseAddress or addr, size))
        if size == 0:
            break
        addr += size
    return res


def read(handle, addr, size):
    """ReadProcessMemory — the ONLY memory-read primitive. bytes or None."""
    if not addr or size <= 0:
        return None
    buf = (ctypes.c_char * size)()
    n = ctypes.c_size_t(0)
    if not _kernel32().ReadProcessMemory(handle, ctypes.c_void_p(addr), buf, size, ctypes.byref(n)):
        return None
    return bytes(buf[:n.value])


def scan(handle, regs, needles, aligned=False):
    """Find byte needles in regions -> {needle: [addresses]}. Single-sweep for 8-byte pointers."""
    found = {n: [] for n in needles}
    if aligned and needles and all(len(n) == 8 for n in needles):
        val2needle = {struct.unpack("<Q", n)[0]: n for n in needles}
        wanted = set(val2needle)
        CHUNK = 16 * 1024 * 1024
        for base, size in regs:
            off = 0
            while off < size:
                n = min(CHUNK, size - off)
                n -= n % 8
                if n <= 0:
                    break
                data = read(handle, base + off, n)
                if data and len(data) >= 8:
                    m = len(data) // 8
                    present = wanted.intersection(struct.unpack("<%dQ" % m, data[:m * 8]))
                    for v in present:
                        nd = val2needle[v]
                        start = 0
                        while True:
                            i = data.find(nd, start)
                            if i < 0:
                                break
                            if i % 8 == 0:
                                found[nd].append(base + off + i)
                            start = i + 1
                off += CHUNK
        return found
    CHUNK = 32 * 1024 * 1024
    OVER = 256
    for base, size in regs:
        off = 0
        while off < size:
            data = read(handle, base + off, min(CHUNK + OVER, size - off))
            if data:
                for nd in needles:
                    start = 0
                    while True:
                        i = data.find(nd, start)
                        if i < 0:
                            break
                        a = base + off + i
                        if not aligned or a % 8 == 0:
                            found[nd].append(a)
                        start = i + 1
            off += CHUNK
    return found


def scan_i64_range(handle, regs, lo, hi, cap=20000):
    """8-aligned addresses whose int64 falls in [lo, hi]."""
    hits = []
    CHUNK = 16 * 1024 * 1024
    for base, size in regs:
        off = 0
        while off < size:
            n = min(CHUNK, size - off)
            n -= n % 8
            if n <= 0:
                break
            data = read(handle, base + off, n)
            if data and len(data) >= 8:
                m = len(data) // 8
                for i, v in enumerate(struct.unpack("<%dQ" % m, data[:m * 8])):
                    if lo <= v <= hi:
                        hits.append(base + off + i * 8)
                        if len(hits) >= cap:
                            return hits
            off += CHUNK
    return hits
