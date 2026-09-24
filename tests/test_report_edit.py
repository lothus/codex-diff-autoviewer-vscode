"""Tests for the CLI hook's path and bridge behavior."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "codex-plugin" / "hooks" / "report_edit.py"
SPEC = importlib.util.spec_from_file_location("report_edit", SCRIPT)
report_edit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report_edit)


class ReportEditTests(unittest.TestCase):
    # Exercise patch parsing, workspace boundaries, and event delivery.
    # Keep tests independent of a running Codex or VS Code process.
    # Use a local receiver to inspect the exact posted event.

    def test_patch_targets(self):
        # Extract created, updated, and renamed files while ignoring deletion.
        command = """*** Begin Patch
*** Add File: new file.py
*** Update File: old.py
*** Move to: renamed.py
*** Delete File: gone.py
*** End Patch"""
        self.assertEqual(
            report_edit.patch_targets(command),
            [("new file.py", "create"), ("renamed.py", "rename")],
        )

    def test_scope_rejects_external_symlink_and_nonfile(self):
        # Reject files outside the workspace even when reached through a link.
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / "workspace"
            workspace.mkdir()
            outside = Path(root) / "outside.txt"
            outside.write_text("x")
            (workspace / "link.txt").symlink_to(outside)
            inside = workspace / "inside.txt"
            inside.write_text("x")
            self.assertEqual(
                report_edit.scoped_regular_file("inside.txt", str(workspace), [str(workspace)]),
                str(inside),
            )
            self.assertIsNone(report_edit.scoped_regular_file("link.txt", str(workspace), [str(workspace)]))
            self.assertIsNone(report_edit.scoped_regular_file(".", str(workspace), [str(workspace)]))

    def test_requires_successful_patch(self):
        # Ignore failed or ambiguous tool responses.
        self.assertTrue(report_edit.successful_patch_response("Success. Updated the following files:"))
        self.assertFalse(report_edit.successful_patch_response("Failed to find expected lines"))
        self.assertFalse(report_edit.successful_patch_response({"output": "Error"}))

    def test_posts_only_scoped_existing_files(self):
        # Run the hook process and receive its authenticated event.
        received = []

        class Receiver(BaseHTTPRequestHandler):
            # Capture one local request from the hook process.
            # Validate its route and authorization header.
            # Suppress server logs so no secret reaches test output.

            def do_POST(self):
                # Store the event body and its authentication header.
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((self.path, self.headers["Authorization"], json.loads(body)))
                self.send_response(204)
                self.end_headers()

            def log_message(self, format, *args):
                # Avoid logging request details during the test.
                pass

        with tempfile.TemporaryDirectory() as root, HTTPServer(("127.0.0.1", 0), Receiver) as server:
            workspace = Path(root) / "workspace"
            workspace.mkdir()
            target = workspace / "new.txt"
            target.write_text("hello")
            descriptor = Path(root) / "bridge.json"
            token = "t" * 32
            descriptor.write_text(json.dumps({
                "version": 1,
                "port": server.server_port,
                "token": token,
                "workspaceFolders": [str(workspace)],
            }))
            descriptor.chmod(0o600)
            thread = threading.Thread(target=server.handle_request, daemon=True)
            thread.start()
            hook = {
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "tool_input": {"command": "*** Begin Patch\n*** Add File: new.txt\n*** Add File: missing.txt\n*** End Patch"},
                "tool_response": "Success. Updated the following files:",
                "cwd": str(workspace),
                "session_id": "session-1",
                "turn_id": "turn-1",
            }
            env = os.environ.copy()
            env["CODEX_AUTO_OPEN_BRIDGE_FILE"] = str(descriptor)
            result = subprocess.run(
                [sys.executable, str(SCRIPT)], input=json.dumps(hook), text=True,
                capture_output=True, env=env, timeout=3, check=True,
            )
            thread.join(timeout=1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            self.assertEqual(len(received), 1)
            route, authorization, event = received[0]
            self.assertEqual(route, "/v1/events")
            self.assertEqual(authorization, f"Bearer {token}")
            self.assertEqual(event["path"], str(target))
            self.assertEqual(event["operation"], "create")
            self.assertEqual(event["sessionId"], "session-1")
            self.assertEqual(event["turnId"], "turn-1")

    def test_rejects_public_descriptor(self):
        # Reject a bridge descriptor readable by other local users.
        with tempfile.TemporaryDirectory() as root:
            descriptor = Path(root) / "bridge.json"
            descriptor.write_text(json.dumps({
                "version": 1, "port": 1234, "token": "t" * 32,
                "workspaceFolders": [root],
            }))
            descriptor.chmod(0o644)
            with patch.dict(os.environ, {"CODEX_AUTO_OPEN_BRIDGE_FILE": str(descriptor)}):
                self.assertIsNone(report_edit.load_bridge())


if __name__ == "__main__":
    unittest.main()
