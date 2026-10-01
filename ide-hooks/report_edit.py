#!/usr/bin/env python3
"""Report Codex file edits to a local VS Code bridge."""

import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from urllib import request


MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_DESCRIPTOR_BYTES = 4096
MAX_METADATA_BYTES = 64 * 1024
PATCH_HEADER = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")
MOVE_HEADER = re.compile(r"^\*\*\* Move to: (.+)$")
WRITE_TOOL = re.compile(r"^mcp__.+__(?:write_file|edit_file|create_file|move_file|rename_file)$")


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
    # Accept successful patch output with or without Codex's tool-result wrapper.
    if isinstance(response, str):
        if response.startswith("Success."):
            return True
        header, marker, output = response.partition("\nOutput:\n")
        return bool(marker and header.startswith("Exit code: 0\n") and
                    output.startswith("Success."))
    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, str):
            return successful_patch_response(output)
        content = response.get("content")
        if isinstance(content, list):
            return any(
                isinstance(item, dict)
                and isinstance(item.get("text"), str)
                and successful_patch_response(item["text"])
                for item in content
            )
    return False


def patch_targets(command):
    # Extract patch destinations and deletion markers from file headers.
    if not isinstance(command, str):
        return []
    targets = []
    current = None
    for line in command.splitlines():
        header = PATCH_HEADER.fullmatch(line)
        if header:
            operation, name = header.groups()
            current = operation
            targets.append((name, {"Add": "create", "Update": "modify", "Delete": "delete"}[operation]))
            continue
        move = MOVE_HEADER.fullmatch(line)
        if move and current == "Update":
            targets.pop()
            targets.append((move.group(1), "rename"))
    return targets


def explicit_targets(hook):
    # Admit paths only from recognized file-writing tool schemas.
    name = hook.get("tool_name")
    tool_input = hook.get("tool_input")
    response = hook.get("tool_response")
    if name == "apply_patch" and isinstance(tool_input, dict) and successful_patch_response(response):
        return patch_targets(tool_input.get("command"))
    if not isinstance(name, str) or not WRITE_TOOL.fullmatch(name) or not isinstance(tool_input, dict):
        return []
    if isinstance(response, dict) and response.get("isError") is True:
        return []
    operation = "rename" if name.endswith(("move_file", "rename_file")) else (
        "create" if name.endswith("create_file") else "modify")
    keys = ("destination", "destination_path", "new_path", "newPath") if operation == "rename" else (
        "path", "file_path", "filePath")
    return [(tool_input[key], operation) for key in keys if isinstance(tool_input.get(key), str)][:1]


def read_bridge(name):
    # Validate one private bridge descriptor before using its address or token.
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
    return {**descriptor, "descriptorPath": str(path)}


def is_ide_session(hook):
    # Require matching VS Code session metadata instead of inherited terminal variables.
    name = hook.get("transcript_path")
    session_id = hook.get("session_id")
    if not isinstance(name, str) or not os.path.isabs(name) or not isinstance(session_id, str) or not session_id:
        return False
    try:
        path = Path(name)
        if not path.is_file():
            return False
        with path.open("rb") as stream:
            line = stream.readline(MAX_METADATA_BYTES + 1)
        if len(line) > MAX_METADATA_BYTES:
            return False
        record = json.loads(line)
    except (OSError, ValueError):
        return False
    if not isinstance(record, dict) or record.get("type") != "session_meta":
        return False
    metadata = record.get("payload")
    return (isinstance(metadata, dict) and metadata.get("id") == session_id
            and metadata.get("source") == "vscode"
            and metadata.get("originator") == "codex_vscode")


def load_bridge(cwd):
    # Discover exactly one live private bridge owning the IDE working directory.
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return None
    try:
        working = Path(cwd).resolve(strict=True)
        candidates = []
        for name in Path(tempfile.gettempdir()).glob("codex-auto-open-*/bridge.json"):
            try:
                directory = name.parent.stat()
                if os.name == "posix" and (directory.st_uid != os.getuid() or directory.st_mode & 0o077):
                    continue
                descriptor = read_bridge(name)
                process_id = descriptor.get("processId") if descriptor else None
                if not isinstance(process_id, int) or isinstance(process_id, bool) or process_id < 1:
                    continue
                if os.name == "posix":
                    os.kill(process_id, 0)
            except (OSError, ValueError):
                continue
            if descriptor and any(working.is_relative_to(Path(folder).resolve(strict=True))
                                  for folder in descriptor["workspaceFolders"]):
                candidates.append(descriptor)
                if len(candidates) > 1:
                    return None
        return candidates[0] if candidates else None
    except (OSError, RuntimeError, ValueError):
        return None


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
    # Report explicit completed edits only from a verified VS Code session.
    hook = read_json_input()
    if not hook:
        return
    event_name = hook.get("hook_event_name")
    if event_name != "PostToolUse" or not is_ide_session(hook):
        return
    cwd = hook.get("cwd")
    targets = explicit_targets(hook)
    if not targets:
        return
    descriptor = load_bridge(cwd)
    if not descriptor or not isinstance(cwd, str) or not os.path.isabs(cwd):
        return
    seen = set()
    for name, operation in targets:
        if operation == "delete":
            continue
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
