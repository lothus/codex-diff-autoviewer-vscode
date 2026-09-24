#!/usr/bin/env python3
"""Exercise the Codex patch hook against the active VS Code development window."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    # Create sample text files and submit one event for each through the active bridge.
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.count <= 20:
        parser.error("--count must be between 1 and 20")
    name = os.environ.get("CODEX_AUTO_OPEN_BRIDGE_FILE")
    if not name:
        parser.error("start a new terminal in the Extension Development Host")
    if not Path(name).is_file():
        parser.error("the bridge descriptor is missing; restart the development host terminal")
    directory = Path.cwd() / "auto-open-smoke" / f"run-{time.time_ns()}"
    directory.mkdir(parents=True)
    turn_id = f"smoke-{time.time_ns()}"
    patch_lines = ["*** Begin Patch"]
    for index in range(1, args.count + 1):
        file = directory / f"sample-{index}.txt"
        file.write_text(f"Codex Auto Open smoke test {index}\n", encoding="utf-8")
        patch_lines.extend([f"*** Add File: {file.relative_to(Path.cwd())}", f"+Smoke test {index}"])
    patch_lines.append("*** End Patch")
    hook = {
        "hook_event_name": "PostToolUse",
        "tool_name": "apply_patch",
        "tool_input": {"command": "\n".join(patch_lines)},
        "tool_response": "Success. Updated the following files:",
        "cwd": str(Path.cwd()),
        "session_id": "smoke-test",
        "turn_id": turn_id,
    }
    script = Path(__file__).resolve().parents[1] / "codex-plugin" / "hooks" / "report_edit.py"
    subprocess.run([sys.executable, str(script)], input=json.dumps(hook), text=True, check=True)
    print(f"Sent {args.count} patch hook event(s) for {directory}")


if __name__ == "__main__":
    main()
