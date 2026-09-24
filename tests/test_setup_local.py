"""Tests for the local two-component setup layout."""

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
    # Check the local catalog shape and copied plugin files.
    # Mock host commands to avoid changing VS Code or Codex settings.
    # Keep all generated files within a temporary directory.

    def test_install_layout_and_commands(self):
        # Build the package layout and invoke the expected host commands.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "catalog"
            commands = []
            with patch.object(setup_local, "marketplace_root", return_value=root), \
                 patch.object(setup_local, "installed_marketplaces", return_value={}), \
                 patch.object(setup_local, "run", side_effect=lambda *args: commands.append(args)), \
                 patch.object(setup_local.shutil, "which", return_value="/usr/bin/tool"):
                setup_local.install()
            catalog = json.loads((root / ".agents/plugins/marketplace.json").read_text())
            plugin = root / "plugins" / setup_local.NAME
            manifest = json.loads((plugin / "plugin.json").read_text())
            self.assertEqual(catalog["name"], setup_local.MARKETPLACE)
            self.assertEqual(catalog["plugins"][0]["source"]["path"],
                             "./plugins/codex-auto-open")
            self.assertTrue((plugin / "hooks" / "report_edit.py").is_file())
            self.assertTrue(manifest["version"].startswith("0.1.0+codex.local-"))
            self.assertEqual(commands[-2],
                             ("codex", "plugin", "add", "codex-auto-open@codex-auto-open-local"))
            self.assertEqual(commands[-1][0:2], ("code", "--install-extension"))


if __name__ == "__main__":
    unittest.main()
