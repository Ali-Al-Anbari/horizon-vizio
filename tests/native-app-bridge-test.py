#!/usr/bin/env python3
"""Local bridge behavior tests. Never contacts a TV."""

import importlib.util
import json
import pathlib
import threading
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("horizon_controller", ROOT / "controller/horizon-controller.py")
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(host_ip="127.0.0.1", tv="127.0.0.1", auth_file="unused")
        self.server = controller.start_local_server(self.args)
        self.server.timeout = 0.1
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:8765"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def launch(self, app="youtube", origin=True, action=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = self.origin
        if action:
            headers["X-Horizon-Action"] = "launch-app"
        request = urllib.request.Request(
            self.origin + "/api/apps/launch", json.dumps({"app": app}).encode(),
            headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_success_and_duplicate_guard(self):
        with patch.object(controller, "load_auth", return_value="private-token"), \
             patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}) as send, \
             patch.object(controller, "current_app_config", return_value={"APP_ID": "1", "NAME_SPACE": 5, "MESSAGE": ""}):
            status, body = self.launch()
            self.assertEqual((status, body["code"]), (200, "launched"))
            self.assertEqual(send.call_args.args[2:4], ("PUT", "/app/launch"))
            self.assertEqual(send.call_args.args[4], {"VALUE": controller.NATIVE_APPS["youtube"]})
            status, body = self.launch()
            self.assertEqual((status, body["code"]), (429, "duplicate"))
            self.assertEqual(send.call_count, 1)

    def test_unsupported_and_unauthorized_do_not_touch_tv(self):
        with patch.object(controller, "tv_request") as send:
            self.assertEqual(self.launch("unverified-app")[0], 404)
            self.assertEqual(self.launch(origin=False)[0], 403)
            self.assertEqual(self.launch(action=False)[0], 400)
            send.assert_not_called()

    def test_catalog_launches_accept_observed_receiver_states(self):
        for app in ("disney-plus", "live-tv", "plex"):
            with self.subTest(app=app):
                self.server.next_launch_at = 0
                observed = controller.NATIVE_APP_EXPECTED_STATES[app][0]
                with patch.object(controller, "load_auth", return_value="private-token"), \
                     patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}), \
                     patch.object(controller, "current_app_config", return_value=observed):
                    status, body = self.launch(app)
                self.assertEqual((status, body["code"]), (200, "launched"))

    def test_stale_mapping_is_not_success(self):
        with patch.object(controller, "load_auth", return_value="private-token"), \
             patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}), \
             patch.object(controller, "current_app_config", return_value={"APP_ID": "17", "NAME_SPACE": 4, "MESSAGE": ""}), \
             patch.object(controller.time, "sleep"):
            status, body = self.launch()
            self.assertEqual((status, body["code"]), (409, "unconfirmed"))

    def test_tv_unavailable_is_explicit(self):
        with patch.object(controller, "load_auth", return_value="private-token"), \
             patch.object(controller, "tv_request", side_effect=urllib.error.URLError("offline")):
            status, body = self.launch()
            self.assertEqual((status, body["code"]), (503, "controller_unavailable"))

    def test_local_assets_are_served_but_source_is_not(self):
        with urllib.request.urlopen(self.origin + "/assets/youtube.svg", timeout=3) as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(self.origin + "/../controller/horizon-controller.py", timeout=3)
        self.assertEqual(denied.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
