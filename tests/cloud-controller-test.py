#!/usr/bin/env python3
"""Cloud polling tests with mock queue and SmartCast responses; no TV traffic."""

import importlib.util
import pathlib
import types
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("horizon_controller", ROOT / "controller/horizon-controller.py")
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class CloudControllerTests(unittest.TestCase):
    def test_every_verified_mapping_uses_its_observed_current_state(self):
        for app, config in controller.NATIVE_APPS.items():
            with self.subTest(app=app):
                observed = controller.NATIVE_APP_EXPECTED_STATES.get(app, [config])[0]
                with patch.object(controller, "load_auth", return_value="tv-token"), \
                     patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}) as send, \
                     patch.object(controller, "current_app_config", return_value=observed):
                    self.assertEqual(controller.launch_cloud_command("tv", "auth-file", app), ("verified", "app_confirmed"))
                self.assertEqual(send.call_args.args[2:4], ("PUT", "/app/launch"))
                self.assertEqual(send.call_args.args[4], {"VALUE": config})

    def test_accepted_api_response_without_current_app_match_is_failure(self):
        wrong = {"APP_ID": "17", "NAME_SPACE": 4, "MESSAGE": "horizon"}
        with patch.object(controller, "load_auth", return_value="tv-token"), \
             patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}), \
             patch.object(controller, "current_app_config", return_value=wrong), \
             patch.object(controller.time, "sleep"):
            self.assertEqual(controller.launch_cloud_command("tv", "auth-file", "plex"), ("failed", "tv_unconfirmed"))

    def test_tv_rejection_and_unavailable_are_distinct(self):
        with patch.object(controller, "load_auth", return_value="tv-token"), \
             patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "FAILURE"}}):
            self.assertEqual(controller.launch_cloud_command("tv", "auth-file", "youtube"), ("failed", "tv_rejected"))
        with patch.object(controller, "load_auth", return_value="tv-token"), \
             patch.object(controller, "tv_request", side_effect=urllib.error.URLError("offline")):
            self.assertEqual(controller.launch_cloud_command("tv", "auth-file", "youtube"), ("failed", "tv_unavailable"))

    def test_poll_rejects_unknown_app_before_tv_access(self):
        claim = {"id": "11111111-1111-4111-8111-111111111111",
                 "claimId": "22222222-2222-4222-8222-222222222222", "app": "netflix"}
        with patch.object(controller, "cloud_request", return_value=(200, claim)), \
             patch.object(controller, "launch_cloud_command") as launch:
            with self.assertRaises(RuntimeError):
                controller.cloud_poll_once("https://example.test", "cloud-secret", "tv", "auth-file")
            launch.assert_not_called()

    def test_poll_reports_only_fixed_result_fields(self):
        claim = {"id": "11111111-1111-4111-8111-111111111111",
                 "claimId": "22222222-2222-4222-8222-222222222222", "app": "plex"}
        with patch.object(controller, "cloud_request", side_effect=[(200, claim), (200, {"id": claim["id"], "state": "verified"})]) as cloud, \
             patch.object(controller, "launch_cloud_command", return_value=("verified", "app_confirmed")) as launch:
            self.assertTrue(controller.cloud_poll_once("https://example.test", "cloud-secret", "tv", "auth-file"))
        launch.assert_called_once_with("tv", "auth-file", "plex")
        self.assertEqual(cloud.call_args.args[2], "/api/controller/result")
        self.assertEqual(cloud.call_args.args[3], {
            "id": claim["id"], "claimId": claim["claimId"],
            "outcome": "verified", "code": "app_confirmed",
        })

    def test_cloud_url_and_credential_file_restrictions(self):
        self.assertEqual(controller.cloud_origin("http://127.0.0.1:8787"), "http://127.0.0.1:8787")
        with self.assertRaises(ValueError):
            controller.cloud_origin("http://public.example")
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "controller-secret"
            path.write_text("a" * 40)
            path.chmod(0o600)
            self.assertEqual(controller.load_cloud_secret(path), "a" * 40)
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                controller.load_cloud_secret(path)

    def test_controller_identifies_itself_to_cloudflare_without_redirects(self):
        with patch.object(controller.urllib.request, "build_opener") as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 204
            self.assertEqual(controller.cloud_request(
                "https://example.test", "private-test-secret", "/api/controller/claim"), (204, None))
            sent = build.return_value.open.call_args.args[0]
            self.assertEqual(sent.get_header("User-agent"), "HorizonController/1.0")
            self.assertIsInstance(build.call_args.args[0], controller.NoCloudRedirects)

    def test_poll_loop_recovers_after_temporary_network_failure(self):
        args = types.SimpleNamespace(
            cloud_url="https://example.test", cloud_secret_file="secret-file",
            tv="tv", auth_file="auth-file", poll_seconds=1, once=False,
        )
        attempts = []

        def poll(*_args):
            attempts.append(1)
            if len(attempts) == 1:
                raise urllib.error.URLError("temporary outage")
            return False

        def sleep(_seconds):
            if len(attempts) >= 2:
                raise KeyboardInterrupt

        with patch.object(controller, "load_cloud_secret", return_value="secret"), \
             patch.object(controller, "cloud_poll_once", side_effect=poll), \
             patch.object(controller.time, "sleep", side_effect=sleep):
            controller.command_cloud_poll(args)
        self.assertEqual(len(attempts), 2)


if __name__ == "__main__":
    unittest.main()
