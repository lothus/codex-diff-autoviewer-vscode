#!/usr/bin/env python3
"""Report Codex file edits to a local VS Code bridge."""

import hashlib
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
MAX_SNAPSHOT_FILES = 5000
MAX_SNAPSHOT_DIRECTORIES = 2000
SNAPSHOT_AGE_SECONDS = 60
SKIPPED_DIRECTORIES = {".git", ".venv", "node_modules", "out", "dist", "build", "coverage", ".next", ".cache"}
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


def load_bridge(cwd=None, ide=False):
    # Select the terminal's descriptor or one unambiguous IDE workspace bridge.
    name = os.environ.get("CODEX_AUTO_OPEN_BRIDGE_FILE")
    if name:
        return read_bridge(name)
    if not ide or not os.environ.get("VSCODE_PID") or not isinstance(cwd, str):
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


def snapshot_path(hook, descriptor=None):
    # Derive a private state path for one Bash tool invocation.
    session_id = hook.get("session_id")
    turn_id = hook.get("turn_id")
    cwd = hook.get("cwd")
    tool_input = hook.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    descriptor_name = os.environ.get("CODEX_AUTO_OPEN_BRIDGE_FILE")
    if descriptor_name is None and descriptor is not None:
        descriptor_name = descriptor.get("descriptorPath")
    if not all(isinstance(value, str) and value for value in (
        session_id, turn_id, cwd, command, descriptor_name)):
        return None
    directory = Path(descriptor_name).parent
    try:
        details = directory.stat()
        if not stat.S_ISDIR(details.st_mode) or (os.name == "posix" and (
            details.st_uid != os.getuid() or details.st_mode & 0o077)):
            return None
    except OSError:
        return None
    digest = hashlib.sha256(json.dumps([session_id, turn_id, cwd, command]).encode()).hexdigest()
    return directory / f"snapshot-{digest}.json"


def workspace_snapshot(folders):
    # Collect bounded file metadata without traversing generated or linked directories.
    files = {}
    directories = 0
    try:
        roots = [Path(folder).resolve(strict=True) for folder in folders]
    except (OSError, RuntimeError, ValueError):
        return None
    for root in roots:
        for current, names, filenames in os.walk(root, followlinks=False):
            directories += 1
            if directories > MAX_SNAPSHOT_DIRECTORIES:
                return None
            names[:] = [name for name in names if name not in SKIPPED_DIRECTORIES and
                        not (Path(current) / name).is_symlink()]
            for name in filenames:
                if len(files) >= MAX_SNAPSHOT_FILES:
                    return None
                candidate = Path(current) / name
                try:
                    resolved = candidate.resolve(strict=True)
                    if not any(resolved.is_relative_to(folder) for folder in roots):
                        continue
                    details = resolved.stat()
                    if stat.S_ISREG(details.st_mode):
                        files[str(resolved)] = [details.st_dev, details.st_ino,
                                                details.st_size, details.st_mtime_ns,
                                                details.st_ctime_ns]
                except (OSError, RuntimeError, ValueError):
                    continue
    return files


def snapshot_changes(before, after):
    # Classify changed regular files and identify moves by device and inode.
    previous_inodes = {(value[0], value[1]): path for path, value in before.items()}
    changes = []
    for path, value in after.items():
        old = before.get(path)
        if old == value:
            continue
        prior_path = previous_inodes.get((value[0], value[1]))
        operation = "rename" if old is None and prior_path and prior_path not in after else (
            "create" if old is None else "modify")
        changes.append((path, operation))
    return changes


def save_snapshot(hook, descriptor):
    # Store the Bash pre-state in the private bridge directory.
    destination = snapshot_path(hook, descriptor)
    if destination is None:
        return
    snapshot = workspace_snapshot(descriptor["workspaceFolders"])
    if snapshot is None:
        return
    try:
        with destination.open("x", encoding="utf-8") as stream:
            os.chmod(destination, 0o600)
            json.dump({"created": time.time(), "files": snapshot}, stream)
    except FileExistsError:
        try:
            destination.unlink()
        except OSError:
            pass
    except OSError:
        pass


def bash_changes(hook, descriptor):
    # Compare a completed Bash call with its matching pre-tool snapshot.
    source = snapshot_path(hook, descriptor)
    if source is None:
        return []
    try:
        with source.open(encoding="utf-8") as stream:
            saved = json.load(stream)
        if not isinstance(saved, dict) or time.time() - saved["created"] > SNAPSHOT_AGE_SECONDS:
            return []
        before = saved["files"]
        if not isinstance(before, dict):
            return []
        after = workspace_snapshot(descriptor["workspaceFolders"])
        return snapshot_changes(before, after) if after is not None else []
    except (OSError, ValueError, KeyError, TypeError):
        return []
    finally:
        try:
            source.unlink(missing_ok=True)
        except OSError:
            pass


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
    # Record Bash pre-state or report scoped post-tool file destinations.
    hook = read_json_input()
    if not hook:
        return
    event_name = hook.get("hook_event_name")
    tool_name = hook.get("tool_name")
    if event_name not in ("PreToolUse", "PostToolUse"):
        return
    cwd = hook.get("cwd")
    ide = "--ide" in sys.argv[1:]
    descriptor = load_bridge(cwd, ide)
    if not descriptor or not isinstance(cwd, str) or not os.path.isabs(cwd):
        return
    if event_name == "PreToolUse":
        if tool_name == "Bash":
            save_snapshot(hook, descriptor)
        return
    targets = bash_changes(hook, descriptor) if tool_name == "Bash" else explicit_targets(hook)
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
