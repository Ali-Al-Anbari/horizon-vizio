#!/usr/bin/env python3
"""Unit tests for SmartCast key command diagnostic in horizon-controller.py."""

import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch, MagicMock

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("horizon_controller", ROOT / "controller/horizon-controller.py")
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class SmartCastKeyTests(unittest.TestCase):
    def test_key_dictionary_contains_required_community_codes(self):
        expected = {
            "pause": (2, 2),
            "play": (2, 3),
            "space": (0, 32),
            "space-52": (0, 52),
            "tab": (0, 9),
            "enter": (0, 13),
            "back": (4, 0),
            "cc": (4, 4),
        }
        for name, (codeset, code) in expected.items():
            self.assertIn(name, controller.SMARTCAST_KEY_COMMANDS)
            entry = controller.SMARTCAST_KEY_COMMANDS[name]
            self.assertEqual(entry["codeset"], codeset, f"{name} codeset mismatch")
            self.assertEqual(entry["code"], code, f"{name} code mismatch")

    def test_send_key_command_builds_exact_payload_and_endpoint(self):
        mock_response = {"STATUS": {"RESULT": "SUCCESS"}}
        with patch.object(controller, "tv_request", return_value=mock_response) as mock_tv:
            resp = controller.send_key_command("192.168.1.50", "secret-token", 2, 2)
            self.assertEqual(resp, mock_response)
            mock_tv.assert_called_once_with(
                "192.168.1.50",
                "secret-token",
                "PUT",
                "/key_command/",
                {
                    "KEYLIST": [
                        {
                            "CODESET": 2,
                            "CODE": 2,
                            "ACTION": "KEYPRESS",
                        }
                    ]
                },
                timeout=3,
            )

    def test_send_key_command_supports_down_and_up_without_changing_mapping(self):
        with patch.object(controller, "tv_request", return_value={"STATUS": {"RESULT": "SUCCESS"}}) as mock_tv:
            controller.send_key_command("192.168.1.50", "secret-token", 0, 9, action="KEYDOWN")
            controller.send_key_command("192.168.1.50", "secret-token", 0, 9, action="KEYUP")
        self.assertEqual(
            [call.args[4]["KEYLIST"][0] for call in mock_tv.call_args_list],
            [
                {"CODESET": 0, "CODE": 9, "ACTION": "KEYDOWN"},
                {"CODESET": 0, "CODE": 9, "ACTION": "KEYUP"},
            ],
        )

    def test_command_key_invokes_correct_codes_from_args(self):
        args = MagicMock()
        args.tv = "192.168.1.50"
        args.auth_file = "auth.json"
        args.key = "pause"
        args.codeset = None
        args.code = None
        args.action = "KEYPRESS"

        with patch.object(controller, "load_auth", return_value="test-token"), \
             patch.object(controller, "send_key_command", return_value={"STATUS": {"RESULT": "SUCCESS"}}) as mock_send:
            controller.command_key(args)
            mock_send.assert_called_once_with("192.168.1.50", "test-token", 2, 2, action="KEYPRESS")

    def test_command_key_accepts_custom_codes(self):
        args = MagicMock()
        args.tv = "192.168.1.50"
        args.auth_file = "auth.json"
        args.key = None
        args.codeset = 5
        args.code = 1
        args.action = "KEYDOWN"

        with patch.object(controller, "load_auth", return_value="test-token"), \
             patch.object(controller, "send_key_command", return_value={"STATUS": {"RESULT": "SUCCESS"}}) as mock_send:
            controller.command_key(args)
            mock_send.assert_called_once_with("192.168.1.50", "test-token", 5, 1, action="KEYDOWN")

    def test_key_cli_defaults_to_keypress_and_accepts_tab_down_up(self):
        for extra, expected in (([], "KEYPRESS"), (["--action", "KEYDOWN"], "KEYDOWN"),
                                (["--action", "KEYUP"], "KEYUP")):
            with self.subTest(action=expected), \
                 patch.object(sys, "argv", ["horizon-controller.py", "key", "--key", "tab"] + extra), \
                 patch.object(controller, "command_key") as mock_handler:
                controller.main()
                args = mock_handler.call_args.args[0]
                self.assertEqual(args.key, "tab")
                self.assertEqual(args.action, expected)

    def test_rejected_action_keeps_existing_response_reporting(self):
        args = MagicMock(tv="192.168.1.50", auth_file="auth.json", key="tab", action="KEYDOWN")
        with patch.object(controller, "load_auth", return_value="test-token"), \
             patch.object(controller, "send_key_command", return_value={"STATUS": {"RESULT": "FAILURE"}}) as mock_send, \
             patch("builtins.print") as mock_print:
            controller.command_key(args)
        mock_send.assert_called_once_with("192.168.1.50", "test-token", 0, 9, action="KEYDOWN")
        mock_print.assert_any_call("SmartCast API response: RESULT=FAILURE (accepted: False)")


if __name__ == "__main__":
    unittest.main()
