"""Tests for the IDE hook's origin, path, and bridge behavior."""

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


SCRIPT = Path(__file__).resolve().parents[1] / "ide-hooks" / "report_edit.py"
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
            [("new file.py", "create"), ("renamed.py", "rename"), ("gone.py", "delete")],
        )

    def test_explicit_write_tools(self):
        # Accept known structured destinations and reject read or failed tools.
        self.assertEqual(report_edit.explicit_targets({
            "tool_name": "mcp__fs__write_file", "tool_input": {"path": "src/a.py"},
            "tool_response": {"isError": False},
        }), [("src/a.py", "modify")])
        self.assertEqual(report_edit.explicit_targets({
            "tool_name": "mcp__fs__move_file", "tool_input": {"source": "a", "destination": "b"},
            "tool_response": {"isError": False},
        }), [("b", "rename")])
        self.assertEqual(report_edit.explicit_targets({
            "tool_name": "mcp__fs__read_file", "tool_input": {"path": "a"},
        }), [])
        self.assertEqual(report_edit.explicit_targets({
            "tool_name": "mcp__fs__write_file", "tool_input": {"path": "a"},
            "tool_response": {"isError": True},
        }), [])

    def test_shell_and_pre_tool_events_are_ignored(self):
        # Reject command side effects without consulting or delivering to the bridge.
        for event in ("PreToolUse", "PostToolUse"):
            with self.subTest(event=event), patch.object(report_edit, "is_ide_session", return_value=True), \
                    patch.object(report_edit, "read_json_input", return_value={
                        "hook_event_name": event, "tool_name": "Bash",
                        "tool_input": {"command": "cargo build"}, "tool_response": "Success.",
                    }), patch.object(report_edit, "load_bridge") as bridge:
                report_edit.main()
                bridge.assert_not_called()

    def test_session_origin_ignores_terminal_environment(self):
        # Admit matching IDE metadata and reject CLI, unknown, and mismatched sessions.
        with tempfile.TemporaryDirectory() as root:
            transcript = Path(root) / "session.jsonl"
            hook = {"session_id": "session-1", "transcript_path": str(transcript)}
            metadata = {"id": "session-1", "source": "vscode", "originator": "codex_vscode"}
            for source, originator, expected in (("vscode", "codex_vscode", True),
                    ("cli", "codex_cli_rs", False), ("exec", "codex_exec", False),
                    ("cli", "codex_vscode", False), ("vscode", "unknown", False)):
                with self.subTest(source=source, originator=originator):
                    transcript.write_text(json.dumps({"type": "session_meta", "payload": {
                        **metadata, "source": source, "originator": originator}}) + "\n")
                    with patch.dict(os.environ, {"VSCODE_PID": "123", "TERM_PROGRAM": "vscode",
                            "CODEX_AUTO_OPEN_BRIDGE_FILE": "/tmp/bridge.json"}):
                        self.assertEqual(report_edit.is_ide_session(hook), expected)
            transcript.write_text(json.dumps({"type": "session_meta", "payload": metadata}))
            self.assertFalse(report_edit.is_ide_session({**hook, "session_id": "another"}))
            self.assertFalse(report_edit.is_ide_session({"session_id": "session-1"}))
            transcript.write_text("not json")
            self.assertFalse(report_edit.is_ide_session(hook))
            transcript.write_text("x" * (report_edit.MAX_METADATA_BYTES + 1))
            self.assertFalse(report_edit.is_ide_session(hook))

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
        # Accept Codex's successful wrapper and ignore failed or ambiguous responses.
        self.assertTrue(report_edit.successful_patch_response("Success. Updated the following files:"))
        wrapped = "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:"
        self.assertTrue(report_edit.successful_patch_response(wrapped))
        self.assertFalse(report_edit.successful_patch_response(wrapped.replace("Exit code: 0", "Exit code: 1")))
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
            directory = Path(root) / "codex-auto-open-test"
            directory.mkdir(mode=0o700)
            descriptor = directory / "bridge.json"
            token = "t" * 32
            descriptor.write_text(json.dumps({
                "version": 1,
                "port": server.server_port,
                "processId": os.getpid(),
                "token": token,
                "workspaceFolders": [str(workspace)],
            }))
            descriptor.chmod(0o600)
            hook = {
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "tool_input": {"command": "*** Begin Patch\n*** Add File: new.txt\n*** Add File: missing.txt\n*** End Patch"},
                "tool_response": "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:",
                "cwd": str(workspace),
                "session_id": "session-1",
                "turn_id": "turn-1",
            }
            transcript = Path(root) / "session.jsonl"
            hook["transcript_path"] = str(transcript)
            env = os.environ.copy()
            env["TMPDIR"] = root
            env["CODEX_AUTO_OPEN_BRIDGE_FILE"] = str(descriptor)
            env["VSCODE_PID"] = str(os.getpid())
            env["TERM_PROGRAM"] = "vscode"
            server.timeout = 0.3
            for source, originator in (("cli", "codex_cli_rs"), ("exec", "codex_exec"),
                                       ("vscode", "codex_vscode")):
                with self.subTest(source=source):
                    transcript.write_text(json.dumps({"type": "session_meta", "payload": {
                        "id": "session-1", "source": source, "originator": originator}}) + "\n")
                    thread = threading.Thread(target=server.handle_request, daemon=True)
                    thread.start()
                    result = subprocess.run(
                        [sys.executable, str(SCRIPT)], input=json.dumps(hook), text=True,
                        capture_output=True, env=env, timeout=3, check=True,
                    )
                    thread.join(timeout=1)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(len(received), 1 if source == "vscode" else 0)
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
            self.assertIsNone(report_edit.read_bridge(descriptor))

    def test_ide_bridge_requires_one_matching_live_window(self):
        # Discover a private IDE bridge only when its workspace match is unique.
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            workspace = base / "workspace"
            workspace.mkdir()
            outside = base / "outside"
            outside.mkdir()
            def descriptor(index, process_id=None):
                # Create one window descriptor with private directory permissions.
                directory = base / f"codex-auto-open-{index}"
                directory.mkdir(mode=0o700)
                file = directory / "bridge.json"
                file.write_text(json.dumps({"version": 1, "port": 1234,
                                            "token": "t" * 32,
                                            "processId": process_id or os.getpid(),
                                            "workspaceFolders": [str(workspace)]}))
                file.chmod(0o600)
                return file
            first = descriptor(1)
            with patch.object(report_edit.tempfile, "gettempdir", return_value=root), \
                    patch.dict(os.environ, {"VSCODE_PID": "123"}, clear=True):
                self.assertIsNone(report_edit.load_bridge(str(outside)))
                self.assertEqual(report_edit.load_bridge(str(workspace))["descriptorPath"],
                                 str(first))
                descriptor(0, 999999999)
                self.assertEqual(report_edit.load_bridge(str(workspace))["descriptorPath"],
                                 str(first))
                descriptor(2)
                self.assertIsNone(report_edit.load_bridge(str(workspace)))


if __name__ == "__main__":
    unittest.main()
