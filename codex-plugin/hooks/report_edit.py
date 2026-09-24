#!/usr/bin/env python3
"""Report successful Codex patch edits to a local VS Code bridge."""

import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib import request


MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_DESCRIPTOR_BYTES = 4096
PATCH_HEADER = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")
MOVE_HEADER = re.compile(r"^\*\*\* Move to: (.+)$")


def read_json_input():
    # Bound the data read from the hook process and require one JSON object.
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        return None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def successful_patch_response(response):
    # Accept only the explicit success marker emitted by apply_patch.
    if isinstance(response, str):
        return response.startswith("Success.")
    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, str):
            return output.startswith("Success.")
        content = response.get("content")
        if isinstance(content, list):
            return any(
                isinstance(item, dict)
                and isinstance(item.get("text"), str)
                and item["text"].startswith("Success.")
                for item in content
            )
    return False


def patch_targets(command):
    # Extract created and modified destinations from apply_patch headers.
    if not isinstance(command, str):
        return []
    targets = []
    current = None
    for line in command.splitlines():
        header = PATCH_HEADER.fullmatch(line)
        if header:
            operation, name = header.groups()
            current = operation
            if operation != "Delete":
                targets.append((name, "create" if operation == "Add" else "modify"))
            continue
        move = MOVE_HEADER.fullmatch(line)
        if move and current == "Update":
            targets.pop()
            targets.append((move.group(1), "rename"))
    return targets


def load_bridge():
    # Read only a private bridge descriptor named by the integrated terminal.
    name = os.environ.get("CODEX_AUTO_OPEN_BRIDGE_FILE")
    if not name:
        return None
    try:
        path = Path(name)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DESCRIPTOR_BYTES:
            return None
        if os.name == "posix" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            return None
        descriptor = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(descriptor, dict) or descriptor.get("version") != 1:
        return None
    port = descriptor.get("port")
    token = descriptor.get("token")
    folders = descriptor.get("workspaceFolders")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        return None
    if not isinstance(token, str) or len(token) < 32 or not token.isascii():
        return None
    if not isinstance(folders, list) or not folders or not all(
        isinstance(folder, str) and os.path.isabs(folder) for folder in folders
    ):
        return None
    return descriptor


def scoped_regular_file(name, cwd, folders):
    # Resolve symlinks and admit only regular files inside a listed workspace.
    if not isinstance(name, str) or not name or "\x00" in name:
        return None
    try:
        path = Path(name)
        resolved = (path if path.is_absolute() else Path(cwd) / path).resolve(strict=True)
        if not resolved.is_file():
            return None
        if any(resolved.is_relative_to(Path(folder).resolve(strict=True)) for folder in folders):
            return str(resolved)
    except (OSError, RuntimeError, ValueError):
        return None
    return None


def send_event(descriptor, event):
    # Send one authenticated event with a short timeout and no proxy.
    payload = json.dumps(event, separators=(",", ":")).encode("utf-8")
    outgoing = request.Request(
        f"http://127.0.0.1:{descriptor['port']}/v1/events",
        data=payload,
        headers={
            "Authorization": f"Bearer {descriptor['token']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    opener = request.build_opener(request.ProxyHandler({}))
    try:
        with opener.open(outgoing, timeout=0.5):
            pass
    except (OSError, ValueError):
        pass


def main():
    # Report verified patch destinations and otherwise leave Codex unaffected.
    hook = read_json_input()
    if not hook or hook.get("hook_event_name") != "PostToolUse":
        return
    if hook.get("tool_name") != "apply_patch" or not successful_patch_response(hook.get("tool_response")):
        return
    descriptor = load_bridge()
    cwd = hook.get("cwd")
    tool_input = hook.get("tool_input")
    if not descriptor or not isinstance(cwd, str) or not os.path.isabs(cwd):
        return
    if not isinstance(tool_input, dict):
        return
    seen = set()
    for name, operation in patch_targets(tool_input.get("command")):
        path = scoped_regular_file(name, cwd, descriptor["workspaceFolders"])
        if not path or path in seen:
            continue
        seen.add(path)
        send_event(descriptor, {
            "version": 1,
            "path": path,
            "operation": operation,
            "sessionId": hook.get("session_id") if isinstance(hook.get("session_id"), str) else None,
            "turnId": hook.get("turn_id") if isinstance(hook.get("turn_id"), str) else None,
            "timestamp": int(time.time() * 1000),
        })


if __name__ == "__main__":
    main()
