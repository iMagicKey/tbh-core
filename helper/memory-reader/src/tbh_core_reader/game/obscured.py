"""obscured.py — read-only ACTk (CodeStage AntiCheat) Obscured value decoding.

Adapted from tbh-meter game/obscured.py (MIT). The algorithms were originally
recovered from the game binary's op_Implicit accessors; the crypto key lives in
the SAME struct and is read live each call (handles ACTk key rotation).

Layout/decoding version is pinned per profile (actk.layoutVersion): a game
update may change the encoding with ZERO offset movement, so decodes are gated
by the runtime XP/level oracle in the main loop, not trusted blindly.
"""

import struct

_BYTE8_PERM = (1, 0, 2, 3, 7, 4, 6, 5)  # ACTkByte8 shuffle of the 1.2.8 build


def _byteswap_1_2(v):
    return (v & 0xFF) | ((v >> 16) & 0xFF) << 8 | ((v >> 8) & 0xFF) << 16 | (v & 0xFF000000)


def _byteswap8(v, perm=None):
    perm = perm or _BYTE8_PERM
    b = [(v >> (8 * i)) & 0xFF for i in range(8)]
    r = 0
    for i, src in enumerate(perm):
        r |= b[src] << (8 * i)
    return r


def decode_obscured_int(hidden, key):
    """value = ((hidden - key) & 0xFFFFFFFF) ^ key. None on unreadable inputs."""
    if hidden is None or key is None:
        return None
    raw = ((((hidden - key) & 0xFFFFFFFF) ^ key) & 0xFFFFFFFF)
    return struct.unpack("<i", struct.pack("<I", raw))[0]


def decode_obscured_float(hidden, key):
    if hidden is None or key is None:
        return None
    bits = (key ^ _byteswap_1_2(hidden)) & 0xFFFFFFFF
    return struct.unpack("<f", struct.pack("<I", bits))[0]


def decode_obscured_double(hidden, key):
    """value = f64(key ^ byteswap8(hidden)); hidden/key are raw u64 words."""
    if hidden is None or key is None:
        return None
    bits = (key ^ _byteswap8(hidden)) & 0xFFFFFFFFFFFFFFFF
    return struct.unpack("<d", struct.pack("<Q", bits))[0]
