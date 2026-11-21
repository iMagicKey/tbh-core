"""Unit tests: PE fingerprint, profile gating, protocol, gold, ACTk, XP, cursor,
stage chain, restart detector, run ids, partial classification."""
import io
import json
import os
import struct
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from tbh_core_reader import pe, protocol  # noqa: E402
from tbh_core_reader.game import obscured  # noqa: E402
from tbh_core_reader.lifecycle import (  # noqa: E402
    LogScanCursor, detect_restart, is_partial, make_run_id, resolve_stage_key)
from tbh_core_reader.metrics import gold as gold_mod  # noqa: E402
from tbh_core_reader.metrics import xp as xp_mod  # noqa: E402
from tbh_core_reader.profile import Profile, ProfileError, load_profile  # noqa: E402

PROFILE_PATH = os.path.join(os.path.dirname(__file__), "..", "profiles", "tbh-1.2.8.json")


class FakeReader:
    """Minimal reader for pe.build_fingerprint over a synthetic module image."""

    BASE = 0x180000000

    def __init__(self, image):
        self._image = image

    def read(self, addr, size):
        off = addr - self.BASE
        if 0 <= off < len(self._image):
            return bytes(self._image[off:off + size])
        return None

    def ri32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<i", b)[0] if b and len(b) == 4 else None


def make_synthetic_dll(tds=0x6AB23E8A, soi=0x6B47000):
    e_lfanew = 0x80
    image = bytearray(e_lfanew + 0x60)
    image[0:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, e_lfanew)
    image[e_lfanew:e_lfanew + 4] = b"PE\x00\x00"
    struct.pack_into("<I", image, e_lfanew + 0x8, tds)
    struct.pack_into("<I", image, e_lfanew + 0x50, soi)
    return bytes(image)


class PeTests(unittest.TestCase):
    def test_fingerprint_from_synthetic_bytes(self):
        reader = FakeReader(make_synthetic_dll())
        fp = pe.build_fingerprint(reader, base=FakeReader.BASE, version="1.2.8")
        self.assertEqual(fp, "1.2.8-0x6ab23e8a-0x6b47000")  # exact profile fingerprint

    def test_bad_signature_yields_none(self):
        image = bytearray(make_synthetic_dll())
        image[0x80:0x84] = b"XX\x00\x00"
        self.assertIsNone(pe.build_fingerprint(FakeReader(bytes(image)), FakeReader.BASE, "1.2.8"))

    def test_version_alone_is_not_identity(self):
        r = FakeReader(make_synthetic_dll(tds=0xDEADBEEF))
        self.assertNotEqual(pe.build_fingerprint(r, FakeReader.BASE, "1.2.8"),
                            pe.build_fingerprint(FakeReader(make_synthetic_dll()),
                                                 FakeReader.BASE, "1.2.8"))


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.profile = load_profile(PROFILE_PATH)

    def test_profile_loads_with_expected_identity(self):
        self.assertEqual(self.profile.fingerprint, "1.2.8-0x6ab23e8a-0x6b47000")
        self.assertEqual(self.profile.game_version, "1.2.8")
        self.assertEqual(self.profile.profile_id, "tbh-1.2.8-a")

    def test_supported_fingerprint_lookup(self):
        self.assertTrue(self.profile.matches_fingerprint("1.2.8-0x6ab23e8a-0x6b47000"))

    def test_unknown_fingerprint_fails_closed(self):
        for candidate in ("1.2.8-0x11111111-0x2222222", "1.2.9-0x6ab23e8a-0x6b47000",
                          "1.2.8", None, ""):
            self.assertFalse(self.profile.matches_fingerprint(candidate),
                             "must fail closed for %r" % candidate)

    def test_malformed_profile_raises(self):
        with self.assertRaises(ProfileError):
            Profile({"schemaVersion": 99})
        with self.assertRaises(ProfileError):
            Profile("not-a-dict")  # type: ignore[arg-type]


class ProtocolTests(unittest.TestCase):
    def test_hello_serialization(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out):
            protocol.hello("1.0.0", "tbh-1.2.8-a")
        msg = json.loads(out.getvalue().strip())
        self.assertEqual(msg, {"type": "hello", "protocolVersion": 1,
                               "readerVersion": "1.0.0", "profileId": "tbh-1.2.8-a"})

    def test_message_sequence_increments(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out):
            protocol.health("healthy", "OK")
            protocol.health("degraded", "X")
            protocol.run_rejected("STAGE_UNAVAILABLE")
        lines = [json.loads(l) for l in out.getvalue().strip().splitlines()]
        self.assertEqual([m["seq"] for m in lines], [1, 2, 3])
        self.assertEqual([m["type"] for m in lines], ["health", "health", "run_rejected"])
        for m in lines:
            self.assertEqual(m["protocolVersion"], 1)
            self.assertIn("observedAtMs", m)

    def test_never_emits_pointer_fields(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out):
            protocol.health("healthy", "OK", detail="some detail")
            protocol.run_completed({"id": "123", "stageKey": 2205, "endedAtMs": 1})
        text = out.getvalue()
        for forbidden in ("0x", "pointer", "klass", "handle"):
            self.assertNotIn(forbidden, text)


class GoldTests(unittest.TestCase):
    def test_monotonic_delta(self):
        self.assertEqual(gold_mod.run_gain(100, 250), 150)
        self.assertEqual(gold_mod.run_gain(100, 100), 0)  # valid zero

    def test_non_monotonic_is_unavailable(self):
        self.assertIsNone(gold_mod.run_gain(100, 90))
        self.assertIsNone(gold_mod.run_gain(None, 5))
        self.assertIsNone(gold_mod.run_gain(5, None))


class ActkTests(unittest.TestCase):
    def _encode_int(self, value, key):
        hidden = ((value ^ key) + key) & 0xFFFFFFFF
        return hidden, key

    def _encode_double(self, value, key):
        # encode = inverse permutation of (value_bits XOR key)
        xbits = struct.unpack("<Q", struct.pack("<d", value))[0] ^ key
        perm = obscured._BYTE8_PERM
        b = [(xbits >> (8 * i)) & 0xFF for i in range(8)]
        hidden = 0
        for i in range(8):
            hidden |= b[perm.index(i)] << (8 * i)
        return hidden, key

    def test_decode_obscured_int_known_vectors(self):
        for value, key in ((91, 12345), (1, 0xFFFFFFFF), (200, 7), (0, 0x5A5A5A5A)):
            hidden, k = self._encode_int(value, key)
            self.assertEqual(obscured.decode_obscured_int(hidden, k), value)

    def test_decode_obscured_double_known_vectors(self):
        for value, key in ((2.154e7, 0x1122334455667788), (0.0, 42), (256967868416.0, 1 << 40)):
            hidden, k = self._encode_double(value, key)
            self.assertAlmostEqual(obscured.decode_obscured_double(hidden, k), value, places=6)

    def test_none_propagates(self):
        self.assertIsNone(obscured.decode_obscured_int(None, 5))
        self.assertIsNone(obscured.decode_obscured_double(5, None))


class XpTests(unittest.TestCase):
    def setUp(self):
        self.profile = load_profile(PROFILE_PATH)

    def test_levelup_accumulation(self):
        acc = xp_mod.PartyXpAccumulator(self.profile)
        curve = self.profile.level_curve
        lv, lv2 = 10, 12
        acc.update({201: (lv, 100.0)})
        acc.update({201: (lv + 1, 50.0)})  # + (curve[10]-100) + 50
        acc.update({201: (lv2, 10.0)})     # + (curve[11]-50) + 10
        expected = (curve[10] - 100.0) + 50.0 + (curve[11] - 50.0) + 10.0
        self.assertAlmostEqual(acc.total(), expected, places=6)
        self.assertTrue(acc.record(201)["levelup"])

    def test_dirty_dip_does_not_advance_baseline(self):
        acc = xp_mod.PartyXpAccumulator(self.profile)
        acc.update({201: (10, 500.0)})
        acc.update({201: (10, 100.0)})   # dip: ignore, keep baseline
        acc.update({201: (10, 700.0)})   # recovery telescopes: +200 only
        self.assertAlmostEqual(acc.total(), 200.0, places=6)

    def test_level_drop_ignored(self):
        acc = xp_mod.PartyXpAccumulator(self.profile)
        acc.update({201: (10, 500.0)})
        acc.update({201: (5, 100.0)})  # level never drops mid-run: dirty read
        acc.update({201: (10, 600.0)})
        self.assertAlmostEqual(acc.total(), 100.0, places=6)

    def test_cap_suppresses_phantom(self):
        acc = xp_mod.PartyXpAccumulator(self.profile)
        cap = max(self.profile.level_curve) + 1  # curve covers 1..100 -> cap is 101
        acc.update({201: (cap, 1000.0)})
        acc.update({201: (cap, 999_999.0)})
        self.assertEqual(acc.total(), 0.0)  # capped: phantom suppressed
        self.assertIsNotNone(acc.total())   # 0.0 is a VALID zero, not None

    def test_late_deploy_seeds_at_first_sighting(self):
        acc = xp_mod.PartyXpAccumulator(self.profile)
        acc.update({201: (10, 500.0)})
        acc.update({301: (10, 200.0)})  # late hero joins
        acc.update({301: (10, 350.0)})
        self.assertAlmostEqual(acc.gain(301), 150.0, places=6)

    def test_total_none_when_nobody_seen(self):
        self.assertIsNone(xp_mod.PartyXpAccumulator(self.profile).total())

    def test_xp_sane_rejects_denormals(self):
        self.assertTrue(xp_mod.xp_sane(0.0))
        self.assertTrue(xp_mod.xp_sane(30.0))
        self.assertFalse(xp_mod.xp_sane(1e-300))
        self.assertFalse(xp_mod.xp_sane(float("nan")))
        self.assertFalse(xp_mod.xp_sane(None))


class CursorTests(unittest.TestCase):
    def _cursor(self):
        c = LogScanCursor()
        return c

    def test_seed_skips_backlog(self):
        entries = [100 + i for i in range(50)]
        c = self._cursor()
        c.seed(lambda i: entries[i], len(entries), 300)
        self.assertEqual(c.new_entries(lambda i: entries[i], len(entries), 300), [])

    def test_new_tail_detected(self):
        entries = [100, 101, 102]
        c = self._cursor()
        c.seed(lambda i: entries[i], 3, 300)
        entries.append(103)
        entries.append(104)
        self.assertEqual(c.new_entries(lambda i: entries[i], len(entries), 300), [103, 104])

    def test_head_eviction_pointer_identity(self):
        # list capped at 3: append evicts the head; indices SHIFT, pointers do not
        window = [100, 101, 102]
        c = self._cursor()
        c.seed(lambda i: window[i], 3, 300)
        window.pop(0)
        window.extend([103, 104])  # now [101,102,103,104]
        self.assertEqual(c.new_entries(lambda i: window[i], len(window), 300), [103, 104])

    def test_oldest_to_newest_order(self):
        window = [100]
        c = self._cursor()
        c.seed(lambda i: window[i], 1, 300)
        window.extend([101, 102, 103])
        self.assertEqual(c.new_entries(lambda i: window[i], len(window), 300),
                         [101, 102, 103])


class StageChainTests(unittest.TestCase):
    CATALOG = {2205: (22, 5, 100, 1), 2206: (22, 6, 105, 1)}

    def test_live_candidate_used_when_in_catalog(self):
        self.assertEqual(resolve_stage_key(2205, 9999, self.CATALOG, None), 2205)

    def test_garbage_live_falls_back_to_snapshot(self):
        # 1.2.8 observed behavior: live monster garbage vs valid snapshot
        self.assertEqual(resolve_stage_key(910401, 2205, self.CATALOG, None), 2205)

    def test_both_invalid_keeps_last_known(self):
        self.assertEqual(resolve_stage_key(910401, 777, self.CATALOG, 2205), 2205)

    def test_none_inputs_keep_last_known(self):
        self.assertEqual(resolve_stage_key(None, None, self.CATALOG, 2206), 2206)


class RestartDetectorTests(unittest.TestCase):
    def test_dead_count_drop_is_restart(self):
        self.assertTrue(detect_restart(150, 30))
        self.assertTrue(detect_restart(150, 147))

    def test_growth_and_noise_are_not(self):
        self.assertFalse(detect_restart(150, 151))
        self.assertFalse(detect_restart(150, 149))  # within slack
        self.assertFalse(detect_restart(None, 5))
        self.assertFalse(detect_restart(5, None))


class RunTests(unittest.TestCase):
    def test_run_completed_carries_provenance(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out):
            protocol.run_completed({"id": "123", "stageKey": 2205, "endedAtMs": 123})
        msg = json.loads(out.getvalue().strip())
        self.assertEqual(msg["type"], "run_completed")
        self.assertEqual(msg["run"]["id"], "123")
        self.assertEqual(msg["observedAtMs"], 123)

    def test_run_id_from_end_ts(self):
        self.assertEqual(make_run_id(1790290787383), "1790290787383")

    def test_partial_classification(self):
        # joined mid-run: < 95% of official clear (gated at >= 30 s)
        self.assertTrue(is_partial("success", 100, 50, 1000))
        self.assertFalse(is_partial("success", 100, 96, 1000))
        # short official clears bypass the ratio clause
        self.assertFalse(is_partial("success", 10, 2, 1000))
        # success with zero damage is always a lost capture
        self.assertTrue(is_partial("success", 10, 9, 0))
        # fails are never 'partial' by this rule
        self.assertFalse(is_partial("fail", 100, 50, 0))

    def test_no_duration_floor(self):
        # a 2-second successful capture is VALID — duration alone never invalidates
        self.assertFalse(is_partial("success", 2, 2, 500))


if __name__ == "__main__":
    unittest.main()
