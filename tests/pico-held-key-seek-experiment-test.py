"""Host-only tests for the isolated held-key experiment; no TV connection."""

import importlib.util
import math
import pathlib
import sys
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE = ROOT / "controller/pico2w/held_seek_experiment.py"
spec = importlib.util.spec_from_file_location("held_seek_experiment", MODULE)
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


class FakeClock:
    def __init__(self):
        self.now = 0
        self.sleep_error = None
        self.on_sleep = None

    def ticks(self):
        return self.now

    def ticks_diff(self, current, start):
        return current - start

    def sleep_ms(self, amount):
        if self.on_sleep:
            self.on_sleep()
        if self.sleep_error:
            raise self.sleep_error
        self.now += amount


class FakeConnection:
    def __init__(self, error_action=None, results=None, warm=True):
        self.error_action = error_action
        self.results = results or {}
        self.warm = warm
        self.requests = []
        self.warmups = 0

    def prewarm(self, token):
        self.warmups += 1
        return self.warm

    def keypress(self, token, body, timing):
        self.requests.append((token, body))
        action = body["KEYLIST"][0]["ACTION"]
        timing.update(http_status=200, request_ms=120, connection="warm", phase="complete")
        if action == self.error_action:
            timing["failed_phase"] = "read_body"
            raise OSError("uncertain response")
        return {"STATUS": {"RESULT": self.results.get(action, "SUCCESS")}}


class FakeTrial:
    def __init__(self, connection=None):
        self._token = "private-token"
        self.connection = connection or FakeConnection()
        self.closes = 0

    def close(self):
        self.closes += 1
        self._token = None


class HeldSeekExperimentTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        main = types.ModuleType("main")
        main.PLAYER_KEYS = {"seek_forward": (3, 7), "seek_backward": (3, 1)}
        main.time = self.clock
        main.ticks = self.clock.ticks
        main.prepare_supervised_player_session = lambda: FakeTrial()
        self.main_patch = patch.dict(sys.modules, {"main": main})
        self.main_patch.start()
        experiment._active = False

    def tearDown(self):
        self.main_patch.stop()
        experiment._active = False

    def test_arbitrary_positive_durations_warm_connection_and_elapsed_time(self):
        for duration in (0.0001, 0.5, 1, 2, 3, 10):
            with self.subTest(duration=duration):
                trial = FakeTrial()
                with patch.object(experiment, "_active", False):
                    result = experiment.held_seek(trial, duration)
                self.assertEqual(result["outcome"], "acknowledged")
                expected_ms = max(1, int(duration * 1000))
                self.assertEqual(result["requested_hold_ms"], expected_ms)
                self.assertEqual(result["hold_ms"], expected_ms)
                self.assertEqual(result["keydown"]["result"], "SUCCESS")
                self.assertEqual(result["keyup"]["result"], "SUCCESS")
                self.assertEqual(result["total_ms"], expected_ms)
                self.assertEqual(trial.connection.warmups, 1)
                self.assertEqual([body for _, body in trial.connection.requests], [
                    {"KEYLIST": [{"CODESET": 3, "CODE": 7, "ACTION": "KEYDOWN"}]},
                    {"KEYLIST": [{"CODESET": 3, "CODE": 7, "ACTION": "KEYUP"}]},
                ])
                self.assertTrue(all(token == "private-token" for token, _ in trial.connection.requests))
                self.assertEqual(trial.closes, 1)
                self.assertNotIn("private-token", str(result))

    def test_keydown_failure_and_hold_failure_still_attempt_keyup(self):
        failed_down = FakeTrial(FakeConnection(error_action="KEYDOWN"))
        result = experiment.held_seek(failed_down, 0.5)
        self.assertEqual(result["keydown"]["outcome"], "unknown")
        self.assertEqual(result["keyup"]["outcome"], "acknowledged")
        self.assertEqual([body["KEYLIST"][0]["ACTION"] for _, body in failed_down.connection.requests],
                         ["KEYDOWN", "KEYUP"])

        self.clock.sleep_error = RuntimeError("sleep failed")
        failed_hold = FakeTrial()
        result = experiment.held_seek(failed_hold, 1)
        self.assertEqual(result["hold_error"], "RuntimeError")
        self.assertEqual(result["keyup"]["outcome"], "acknowledged")
        self.assertEqual(failed_hold.connection.requests[-1][1]["KEYLIST"][0]["ACTION"], "KEYUP")

    def test_rejected_down_best_effort_release_and_keyup_failure_are_reported(self):
        rejected = FakeTrial(FakeConnection(results={"KEYDOWN": "FAILURE"}))
        result = experiment.held_seek(rejected, 0.5)
        self.assertEqual(result["keydown"]["outcome"], "rejected")
        self.assertEqual(result["keyup"]["outcome"], "acknowledged")
        self.assertEqual(result["hold_ms"], 0)

        release_unknown = FakeTrial(FakeConnection(error_action="KEYUP"))
        result = experiment.held_seek(release_unknown, 0.5)
        self.assertEqual(result["keyup"]["outcome"], "unknown")
        self.assertEqual(result["keyup"]["phase"], "read_body")

    def test_duration_and_mapping_limits_fail_before_sending(self):
        for value in (0, -0.25, math.inf, -math.inf, math.nan, True, "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                experiment.held_seek(FakeTrial(), value)
        trial = FakeTrial()
        sys.modules["main"].PLAYER_KEYS["seek_forward"] = (3, 8)
        with self.assertRaises(RuntimeError):
            experiment.held_seek(trial, 0.5)
        self.assertEqual(trial.connection.requests, [])
        self.assertEqual(trial.closes, 0)

    def test_trial_is_one_use_after_keydown_and_keyup(self):
        trial = FakeTrial()
        experiment.held_seek(trial, 0.5)
        with self.assertRaisesRegex(RuntimeError, "live supervised trial"):
            experiment.held_seek(trial, 10)
        self.assertEqual([body["KEYLIST"][0]["ACTION"] for _, body in trial.connection.requests],
                         ["KEYDOWN", "KEYUP"])
        self.assertEqual(trial.closes, 1)

    def test_failed_read_only_warmup_sends_no_key_and_closes_trial(self):
        trial = FakeTrial(FakeConnection(warm=False))
        result = experiment.held_seek(trial, 0.5)
        self.assertEqual(result["outcome"], "not_sent")
        self.assertEqual(result["warmup"], "rejected")
        self.assertEqual(trial.connection.requests, [])
        self.assertEqual(trial.closes, 1)

    def test_overlapping_call_is_rejected_and_outer_test_still_releases(self):
        trial = FakeTrial()
        nested = []

        def attempt_overlap():
            if not nested:
                with self.assertRaisesRegex(RuntimeError, "already active"):
                    experiment.held_seek(FakeTrial(), 0.5)
                nested.append(True)

        self.clock.on_sleep = attempt_overlap
        result = experiment.held_seek(trial, 0.5)
        self.assertEqual(result["keyup"]["outcome"], "acknowledged")
        self.assertEqual([body["KEYLIST"][0]["ACTION"] for _, body in trial.connection.requests],
                         ["KEYDOWN", "KEYUP"])
        self.assertEqual(trial.closes, 1)


if __name__ == "__main__":
    unittest.main()
