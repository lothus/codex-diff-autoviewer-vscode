#!/usr/bin/env python3
"""Run Codex Auto Open tests inside an isolated VS Code Extension Host."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def main():
    # Launch the installed VS Code binary with disposable profile and workspace paths.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="codex-auto-open-host-") as temporary:
        base = Path(temporary)
        workspace = base / "workspace"
        workspace.mkdir()
        subprocess.run(["git", "init", "--quiet", str(workspace)], check=True)
        (workspace / "tracked.rs").write_text("committed baseline\n")
        (workspace / "old-name.rs").write_text("rename baseline\n")
        (workspace / ".gitignore").write_text("dist/\nignored.txt\n")
        subprocess.run(["git", "-C", str(workspace), "add", "."], check=True)
        subprocess.run(["git", "-C", str(workspace), "-c", "user.name=Extension Host Test",
                        "-c", "user.email=extension-host@example.invalid", "commit", "--quiet",
                        "-m", "Prepare diff fixtures"], check=True)
        outside = base / "outside"
        outside.mkdir()
        workspace_file = base / "diff-tests.code-workspace"
        workspace_file.write_text(json.dumps({"folders": [
            {"path": str(workspace)}, {"path": str(outside)}]}))
        environment = os.environ.copy()
        for name in ("ELECTRON_RUN_AS_NODE", "VSCODE_CLI", "VSCODE_IPC_HOOK_CLI"):
            environment.pop(name, None)
        executable = Path('/usr/share/code/code')
        if not executable.is_file():
            executable = Path(shutil.which('code') or 'code')
        command = [
            str(executable),
            f"--user-data-dir={base / 'user-data'}",
            f"--extensions-dir={base / 'extensions'}",
            f"--extensionDevelopmentPath={ROOT / 'vscode-extension'}",
            f"--extensionTestsPath={ROOT / 'vscode-extension' / 'out' / 'hostTests' / 'run.js'}",
            "--skip-welcome",
            "--disable-workspace-trust",
            str(workspace_file),
        ]
        result = subprocess.run(command, capture_output=True, text=True,
                                env=environment, timeout=180)
        output = result.stdout + result.stderr
        for line in output.splitlines():
            if line.startswith("Extension Host "):
                print(line)
        if result.returncode != 0:
            raise RuntimeError(f"Extension Host exited {result.returncode}: {output[-4000:]}")
        expected = "Extension Host synthetic hook checks passed"
        if expected not in output:
            raise RuntimeError("Extension Host did not report completed tests")


if __name__ == "__main__":
    main()
