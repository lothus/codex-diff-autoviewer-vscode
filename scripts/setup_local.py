#!/usr/bin/env python3
"""Install or remove the local Codex Auto Open development build."""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]
NAME = "codex-auto-open"
EXTENSION_ID = "local.codex-auto-open"
IDE_HOOK_MARKER = "Codex Auto Open IDE bridge"


def run(*command):
    # Run a required packaging or host command and report its failure.
    subprocess.run(command, check=True)


def ide_hooks_path():
    # Locate the user hook configuration used by the IDE extension.
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "hooks.json"


def update_ide_hooks(script=None):
    # Replace project-owned hooks while preserving unrelated handlers.
    path = ide_hooks_path()
    if script is None and not path.exists():
        return
    if path.is_symlink():
        raise RuntimeError(f"Refusing to edit symlink: {path}")
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"hooks": {}}
    if not isinstance(data, dict) or not isinstance(data.get("hooks"), dict):
        raise RuntimeError(f"Unsupported hooks file: {path}")
    for event in ("PreToolUse", "PostToolUse"):
        groups = data["hooks"].get(event, [])
        if not isinstance(groups, list):
            raise RuntimeError(f"Unsupported {event} hooks in {path}")
        retained = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                retained.append(group)
                continue
            handlers = [handler for handler in group["hooks"] if not (
                isinstance(handler, dict) and handler.get("statusMessage") == IDE_HOOK_MARKER)]
            if len(handlers) == len(group["hooks"]):
                retained.append(group)
            elif handlers:
                retained.append({**group, "hooks": handlers})
        data["hooks"][event] = retained
    if script is not None:
        command = f"python3 {shlex.quote(str(script))}"
        matchers = {
            "PostToolUse": "^apply_patch$|^mcp__.+__(?:write_file|edit_file|create_file|move_file|rename_file)$",
        }
        for event, matcher in matchers.items():
            data["hooks"][event].append({
                "matcher": matcher,
                "hooks": [{"type": "command", "command": command,
                           "timeout": 3,
                           "statusMessage": IDE_HOOK_MARKER}],
            })
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".codex-auto-open-tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(data, stream, indent=2)
            stream.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def hook_root():
    # Store the standalone IDE hook outside the source checkout.
    return ide_hooks_path().parent / "hooks" / NAME


def install():
    # Package the VS Code extension and install its standalone IDE hook.
    for executable in ("npm", "code"):
        if shutil.which(executable) is None:
            raise RuntimeError(f"{executable} is required on PATH")
    run("npm", "ci", "--prefix", str(ROOT / "vscode-extension"))
    run("npm", "run", "package", "--prefix", str(ROOT / "vscode-extension"))
    target = hook_root()
    target.mkdir(parents=True, exist_ok=True)
    script = target / "report_edit.py"
    if target.is_symlink() or script.is_symlink():
        raise RuntimeError(f"Refusing to install into symlink: {target}")
    shutil.copy2(ROOT / "ide-hooks" / "report_edit.py", script)
    run("code", "--install-extension", str(ROOT / "dist" / f"{NAME}.vsix"), "--force")
    update_ide_hooks(script)
    print("Installed the VS Code extension and IDE hook. Restart VS Code and Codex, then review /hooks.")


def remove():
    # Remove the VS Code extension and this project's standalone IDE hook.
    run("code", "--uninstall-extension", EXTENSION_ID)
    update_ide_hooks()
    target = hook_root()
    if target.is_symlink():
        raise RuntimeError(f"Refusing to remove symlink: {target}")
    script = target / "report_edit.py"
    script.unlink(missing_ok=True)
    if target.exists() and not any(target.iterdir()):
        target.rmdir()
    print("Removed the VS Code extension and IDE hook.")


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
