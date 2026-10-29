"""Host-only tests for the supervised KEYLIST experiment; no TV connection."""

import importlib.util
import io
import pathlib
import sys
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "controller/pico2w/seek_batch_experiment.py"
spec = importlib.util.spec_from_file_location("seek_batch_experiment", MODULE_PATH)
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


class FakeConnection:
    def __init__(self, response=None, error=None, warm=True):
        self.response = response or {"STATUS": {"RESULT": "SUCCESS"}}
        self.error = error
        self.warm = warm
        self.wrapped = object() if warm else None
        self.requests = []
        self.prewarms = 0

    def prewarm(self, token):
        self.prewarms += 1
        return self.warm

    def keypress(self, token, body, timing):
        self.requests.append((token, body))
        timing["request_ms"] = 123
        timing["connection"] = "warm"
        if self.error:
            raise self.error
        return self.response


class FakeTrial:
    def __init__(self, connection=None, single_results=(True, True)):
        self._token = "private-test-token"
        self.connection = connection or FakeConnection()
        self.single_results = iter(single_results)
        self.single_calls = []
        self.closes = 0

    def send(self, command):
        self.single_calls.append(command)
        return next(self.single_results)

    def close(self):
        self.closes += 1
        self._token = None


class SeekBatchExperimentTests(unittest.TestCase):
    def controller(self, trial=None, mapping=(3, 7)):
        module = types.ModuleType("main")
        module.PLAYER_KEYS = {"seek_forward": mapping, "seek_backward": (3, 1)}
        module.prepare_supervised_player_session = lambda: trial
        module.ticks = lambda: 100
        module.time = types.SimpleNamespace(ticks_diff=lambda a, b: a - b)
        return patch.dict(sys.modules, {"main": module})

    def test_fixed_request_shape_is_two_identical_forward_keypresses(self):
        trial = FakeTrial()
        with self.controller(trial):
            result = experiment.batched_pair(trial)
        self.assertEqual(result, {"outcome": "acknowledged", "requested_keys": 2,
                                  "request_ms": 123})
        self.assertEqual(trial.connection.requests, [("private-test-token", {"KEYLIST": [
            {"CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"},
            {"CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"},
        ]})])
        self.assertEqual(trial.connection.prewarms, 1)
        self.assertEqual(trial.closes, 1)
        self.assertNotIn("private-test-token", str(result))

    def test_batch_size_and_mapping_fail_closed(self):
        for count in (0, 1, 3, 61, True, 2.0, "2"):
            with self.subTest(count=count), self.assertRaises(ValueError):
                experiment._forward_body(count)
        for count in (2, 6, 12, 30, 60):
            with self.subTest(count=count):
                self.assertEqual(len(experiment._forward_body(count)["KEYLIST"]), count)
        trial = FakeTrial()
        with self.controller(trial, mapping=(3, 8)), self.assertRaises(RuntimeError):
            experiment.batched_pair(trial)
        self.assertEqual(trial.connection.requests, [])
        self.assertEqual(trial.closes, 1)

    def test_batched_trial_sends_one_request_with_exact_allowed_count_and_prints_diagnostics(self):
        for count in (2, 6, 12, 30, 60):
            for command, code in (("seek_forward", 7), ("seek_backward", 1)):
                with self.subTest(count=count, command=command):
                    trial = FakeTrial()
                    output = io.StringIO()
                    with self.controller(trial), redirect_stdout(output):
                        result = experiment.batched_trial(trial, count, command)
                    self.assertEqual(result, {"outcome": "acknowledged", "requested_keys": count,
                                              "request_ms": 123})
                    self.assertEqual(len(trial.connection.requests), 1)
                    self.assertEqual(len(trial.connection.requests[0][1]["KEYLIST"]), count)
                    self.assertTrue(all(key == {"CODESET": 3, "CODE": code, "ACTION": "KEYPRESS"}
                                        for key in trial.connection.requests[0][1]["KEYLIST"]))
                    self.assertEqual(trial.connection.prewarms, 1)
                    self.assertEqual(trial.closes, 1)
                    self.assertIn("requested %d keys" % count, output.getvalue())
                    self.assertIn("acknowledgment acknowledged", output.getvalue())
                    self.assertIn("request 123 ms", output.getvalue())

    def test_batched_trial_rejects_other_counts_and_never_retries_uncertain_request(self):
        for count in (0, 1, 3, 61, True, 6.0, "12"):
            trial = FakeTrial()
            with self.subTest(count=count), self.controller(trial), self.assertRaises(ValueError):
                experiment.batched_trial(trial, count)
            self.assertEqual(trial.connection.requests, [])
            self.assertEqual(trial.closes, 1)

        trial = FakeTrial()
        with self.controller(trial), self.assertRaises(ValueError):
            experiment.batched_trial(trial, 30, "pause_toggle")
        self.assertEqual(trial.connection.requests, [])
        self.assertEqual(trial.closes, 1)

        trial = FakeTrial(FakeConnection(error=OSError("response lost after write")))
        output = io.StringIO()
        with self.controller(trial), redirect_stdout(output):
            result = experiment.batched_trial(trial, 12)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["requested_keys"], 12)
        self.assertEqual(len(trial.connection.requests), 1)
        self.assertEqual(trial.closes, 1)
        self.assertIn("acknowledgment unknown", output.getvalue())

    def test_prepare_sends_no_tv_request_and_bad_warmup_stops_before_key(self):
        trial = FakeTrial()
        with self.controller(trial):
            self.assertIs(experiment.prepare_trial(), trial)
        self.assertEqual(trial.connection.prewarms, 0)
        self.assertEqual(trial.connection.requests, [])
        self.assertEqual(trial.single_calls, [])

        failed = FakeTrial(FakeConnection(warm=False))
        with self.controller(failed):
            self.assertEqual(experiment.batched_pair(failed),
                             {"outcome": "not_sent", "requested_keys": 0,
                              "reason": "read_only_warmup_failed"})
        self.assertEqual(failed.connection.requests, [])
        self.assertEqual(failed.connection.prewarms, 1)
        self.assertEqual(failed.closes, 1)

    def test_transport_error_is_unknown_and_never_retried(self):
        trial = FakeTrial(FakeConnection(error=OSError("response lost after write")))
        with self.controller(trial):
            result = experiment.batched_pair(trial)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["error_type"], "OSError")
        self.assertEqual(len(trial.connection.requests), 1)
        self.assertEqual(trial.closes, 1)

    def test_rejection_does_not_claim_playback_or_retry(self):
        trial = FakeTrial(FakeConnection(response={"STATUS": {"RESULT": "FAILURE"}}))
        with self.controller(trial):
            result = experiment.batched_pair(trial)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(len(trial.connection.requests), 1)
        self.assertEqual(trial.closes, 1)

    def test_separate_comparison_uses_existing_single_command_and_stops_on_failure(self):
        good = FakeTrial()
        with self.controller(good):
            self.assertEqual(experiment.separate_pair(good),
                             {"outcome": "acknowledged", "acknowledged_requests": 2})
        self.assertEqual(good.single_calls, ["seek_forward", "seek_forward"])
        self.assertEqual(good.closes, 1)

        uncertain = FakeTrial(single_results=(False, True))
        with self.controller(uncertain):
            self.assertEqual(experiment.separate_pair(uncertain),
                             {"outcome": "stopped_unknown_or_rejected",
                              "acknowledged_requests": 0})
        self.assertEqual(uncertain.single_calls, ["seek_forward"])
        self.assertEqual(uncertain.closes, 1)

    def test_sequential_trial_uses_exactly_one_fixed_key_per_request_for_staged_counts(self):
        for count in experiment.SEQUENTIAL_COUNTS:
            with self.subTest(count=count):
                trial = FakeTrial()
                with self.controller(trial):
                    result = experiment.sequential_trial(trial, count)
                self.assertEqual(result["requested"], count)
                self.assertEqual(result["acknowledged"], count)
                self.assertEqual(result["failures"], 0)
                self.assertEqual(result["warm_requests"], count)
                self.assertEqual(result["min_ms"], 123)
                self.assertEqual(len(trial.connection.requests), count)
                self.assertTrue(all(body == {"KEYLIST": [{
                    "CODESET": 3, "CODE": 7, "ACTION": "KEYPRESS"}]}
                    for _, body in trial.connection.requests))
                self.assertEqual(trial.closes, 1)
        trial = FakeTrial()
        with self.controller(trial):
            result = experiment.sequential_trial(trial, 3, "seek_backward")
        self.assertEqual(result["acknowledged"], 3)
        self.assertEqual(trial.connection.requests[0][1]["KEYLIST"][0]["CODE"], 1)

    def test_sequential_trial_rejects_non_staged_counts_and_stops_on_uncertainty(self):
        for count in (0, 1, 4, 61, True, "3"):
            with self.subTest(count=count), self.assertRaises(ValueError):
                experiment.sequential_trial(FakeTrial(), count)
        trial = FakeTrial(FakeConnection(error=OSError("response lost")))
        with self.controller(trial):
            result = experiment.sequential_trial(trial, 6)
        self.assertEqual(result["acknowledged"], 0)
        self.assertEqual(result["failure"]["kind"], "uncertain_transport")
        self.assertEqual(len(trial.connection.requests), 1)
        self.assertEqual(trial.closes, 1)


if __name__ == "__main__":
    unittest.main()
