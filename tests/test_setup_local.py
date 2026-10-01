"""Tests for the local IDE-only setup layout."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "setup_local.py"
SPEC = importlib.util.spec_from_file_location("setup_local", SCRIPT)
setup_local = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_local)


class SetupLocalTests(unittest.TestCase):
    # Check the standalone hook layout and extension installation.
    # Mock host commands to avoid changing VS Code or Codex settings.
    # Keep all generated files within a temporary directory.

    def test_install_layout_and_commands(self):
        # Install a standalone hook and extension without invoking the Codex CLI.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "hook"
            commands = []
            with patch.object(setup_local, "hook_root", return_value=root), \
                 patch.object(setup_local, "ide_hooks_path", return_value=Path(temporary) / "hooks.json"), \
                 patch.object(setup_local, "run", side_effect=lambda *args: commands.append(args)), \
                 patch.object(setup_local.shutil, "which", return_value="/usr/bin/tool"):
                setup_local.install()
            self.assertTrue((root / "report_edit.py").is_file())
            self.assertEqual(commands[-1][0:2], ("code", "--install-extension"))
            self.assertFalse(any(command[0] == "codex" for command in commands))
            hooks = json.loads((Path(temporary) / "hooks.json").read_text())["hooks"]
            self.assertEqual(hooks["PreToolUse"], [])
            self.assertNotIn("Bash", hooks["PostToolUse"][0]["matcher"])
            self.assertNotIn("--ide", hooks["PostToolUse"][0]["hooks"][0]["command"])

    def test_upgrade_removes_legacy_snapshot_hooks(self):
        # Replace obsolete project hooks while retaining unrelated pre-tool handlers.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "hooks.json"
            own = {"hooks": [{"statusMessage": setup_local.IDE_HOOK_MARKER, "command": "old"}]}
            unrelated = {"matcher": "other", "hooks": [{"command": "true"}]}
            path.write_text(json.dumps({"hooks": {"PreToolUse": [own, unrelated], "PostToolUse": [own]}}))
            with patch.object(setup_local, "ide_hooks_path", return_value=path):
                setup_local.update_ide_hooks(Path(temporary) / "report_edit.py")
            hooks = json.loads(path.read_text())["hooks"]
            self.assertEqual(hooks["PreToolUse"], [unrelated])
            self.assertEqual(len(hooks["PostToolUse"]), 1)
            self.assertNotIn("Bash", hooks["PostToolUse"][0]["matcher"])

    def test_mixed_group_preserves_unrelated_handler(self):
        # Keep unrelated handlers even when they share a group with this project's hook.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "hooks.json"
            unrelated = {"type": "command", "command": "true"}
            path.write_text(json.dumps({"hooks": {"PostToolUse": [{"matcher": "*", "hooks": [
                unrelated, {"statusMessage": setup_local.IDE_HOOK_MARKER, "command": "old"}]}]}}))
            with patch.object(setup_local, "ide_hooks_path", return_value=path):
                setup_local.update_ide_hooks()
            self.assertEqual(json.loads(path.read_text())["hooks"]["PostToolUse"],
                             [{"matcher": "*", "hooks": [unrelated]}])

    def test_remove_standalone_hook(self):
        # Remove only the installed hook and leave unrelated files untouched.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "report_edit.py").write_text("hook")
            (root / "unrelated").write_text("keep")
            with patch.object(setup_local, "hook_root", return_value=root), \
                 patch.object(setup_local, "ide_hooks_path", return_value=root / "hooks.json"), \
                 patch.object(setup_local, "run") as run:
                setup_local.remove()
            run.assert_called_once_with("code", "--uninstall-extension", setup_local.EXTENSION_ID)
            self.assertFalse((root / "report_edit.py").exists())
            self.assertTrue((root / "unrelated").exists())

    def test_ide_hooks_preserve_user_entries_and_remove_only_own(self):
        # Keep unrelated hook groups intact across installation and removal.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "hooks.json"
            original = {"description": "Personal hooks", "hooks": {
                "PostToolUse": [{"matcher": "^other$", "hooks": [{"type": "command", "command": "true"}]}]}}
            path.write_text(json.dumps(original))
            with patch.object(setup_local, "ide_hooks_path", return_value=path):
                setup_local.update_ide_hooks(Path(temporary) / "report_edit.py")
                setup_local.update_ide_hooks()
            self.assertEqual(json.loads(path.read_text())["hooks"]["PostToolUse"],
                             original["hooks"]["PostToolUse"])
            self.assertEqual(json.loads(path.read_text())["description"], "Personal hooks")


if __name__ == "__main__":
    unittest.main()
