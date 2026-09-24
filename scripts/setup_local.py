#!/usr/bin/env python3
"""Install or remove the local Codex Auto Open development build."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
NAME = "codex-auto-open"
MARKETPLACE = "codex-auto-open-local"
EXTENSION_ID = "local.codex-auto-open"


def run(*command):
    # Run a required packaging or host command and report its failure.
    subprocess.run(command, check=True)


def marketplace_root():
    # Keep this project's local catalog separate from other plugin marketplaces.
    return Path.home() / ".local" / "share" / NAME


def installed_marketplaces():
    # Read Codex's configured sources to avoid registering the catalog twice.
    result = subprocess.run(
        ["codex", "plugin", "marketplace", "list", "--json"],
        check=True, capture_output=True, text=True,
    )
    return {item["name"]: Path(item["root"]).resolve()
            for item in json.loads(result.stdout)["marketplaces"]}


def install():
    # Package the extension and register a versioned copy of the plugin.
    for executable in ("npm", "code", "codex"):
        if shutil.which(executable) is None:
            raise RuntimeError(f"{executable} is required on PATH")
    run("npm", "ci", "--prefix", str(ROOT / "vscode-extension"))
    run("npm", "run", "package", "--prefix", str(ROOT / "vscode-extension"))
    root = marketplace_root()
    sources = installed_marketplaces()
    if MARKETPLACE in sources and sources[MARKETPLACE] != root.resolve():
        raise RuntimeError(f"{MARKETPLACE} already points to {sources[MARKETPLACE]}")
    root.mkdir(parents=True, exist_ok=True)
    target = root / "plugins" / NAME
    target.mkdir(parents=True, exist_ok=True)
    for source in (ROOT / "codex-plugin" / "plugin.json",
                   ROOT / "codex-plugin" / "hooks" / "hooks.json",
                   ROOT / "codex-plugin" / "hooks" / "report_edit.py"):
        destination = target / source.relative_to(ROOT / "codex-plugin")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    manifest = target / "plugin.json"
    plugin = json.loads(manifest.read_text(encoding="utf-8"))
    plugin["version"] = (f"{plugin['version'].split('+', 1)[0]}+codex.local-"
                         f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S%f}")
    manifest.write_text(json.dumps(plugin, indent=2) + "\n", encoding="utf-8")
    catalog = {
        "name": MARKETPLACE,
        "interface": {"displayName": "Codex Auto Open Local"},
        "plugins": [{
            "name": NAME,
            "source": {"source": "local", "path": f"./plugins/{NAME}"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Productivity",
        }],
    }
    catalog_path = root / ".agents" / "plugins" / "marketplace.json"
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(
        json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    if MARKETPLACE not in sources:
        run("codex", "plugin", "marketplace", "add", str(root))
    run("codex", "plugin", "add", f"{NAME}@{MARKETPLACE}")
    run("code", "--install-extension", str(ROOT / "dist" / f"{NAME}.vsix"), "--force")
    print("Installed both components. Restart VS Code and Codex, then review the hook with /hooks.")


def remove():
    # Unregister both components and leave unrelated local files untouched.
    root = marketplace_root()
    sources = installed_marketplaces()
    if MARKETPLACE in sources and sources[MARKETPLACE] != root.resolve():
        raise RuntimeError(f"{MARKETPLACE} points to another catalog: {sources[MARKETPLACE]}")
    if MARKETPLACE in sources:
        run("codex", "plugin", "remove", f"{NAME}@{MARKETPLACE}")
        run("codex", "plugin", "marketplace", "remove", MARKETPLACE)
    run("code", "--uninstall-extension", EXTENSION_ID)
    if (root / ".agents" / "plugins" / "marketplace.json").is_file():
        shutil.rmtree(root)
    print("Removed both components.")


def main():
    # Parse the requested local setup action and display actionable errors.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "remove"))
    args = parser.parse_args()
    try:
        (install if args.action == "install" else remove)()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, RuntimeError) as error:
        parser.exit(1, f"Setup failed: {error}\n")


if __name__ == "__main__":
    main()
