#!/usr/bin/env python3
"""Standalone Codex MCP and hook-trust synchronizer for bflow iso profiles."""
from __future__ import annotations

import errno
import os
import re
import stat
import sys
import tempfile
import tomllib
import time
from pathlib import Path

_HOOK_STATE_BODY = r'"\]\n((?:(?!\[)[^\n]*\n?)*)'
_TOML_TABLE = re.compile(r"^\s*\[\[?([^\]]+)\]?\]\s*(?:#.*)?$")
SYNC_ATTEMPTS = 3


def _toml_basic(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _hook_state_sections(text: str, old_source: Path, new_source: Path) -> list[tuple[str, str]]:
    old_prefix = _toml_basic(str(old_source)) + ":"
    new_prefix = _toml_basic(str(new_source)) + ":"
    pattern = r'^\[hooks\.state\."' + re.escape(old_prefix) + r'([^"]+)' + _HOOK_STATE_BODY
    return [(f"{new_prefix}{m.group(1)}", m.group(2).rstrip()) for m in re.finditer(pattern, text, re.M)]


def _table_path(header: str) -> tuple[str, ...]:
    parts: list[str] = []
    cur, quote = "", ""
    for ch in header:
        if quote:
            if ch == quote:
                quote = ""
            else:
                cur += ch
        elif ch in "\"'":
            quote = ch
        elif ch == ".":
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    parts.append(cur.strip())
    return tuple(parts)


def _split_mcp_tables(text: str, servers: frozenset[str] | None) -> tuple[str, str]:
    keep: list[str] = []
    mcp: list[str] = []
    in_mcp = False
    for line in text.splitlines(keepends=True):
        if match := _TOML_TABLE.match(line):
            path = _table_path(match.group(1))
            in_mcp = path[0] == "mcp_servers" and (servers is None or (len(path) > 1 and path[1] in servers))
        (mcp if in_mcp else keep).append(line)
    return "".join(keep), "".join(mcp)


def _merge_profile_config(target_text: str, replacement: str, servers: frozenset[str],
                          hook_sections: list[tuple[str, str]]) -> str:
    kept = _split_mcp_tables(target_text, servers)[0].rstrip()
    merged = f"{kept}\n\n{replacement}\n" if kept else f"{replacement}\n"
    for key, body in hook_sections:
        section = f'[hooks.state."{key}"]\n{body}\n'
        existing = re.search(r'^\[hooks\.state\."' + re.escape(key) + _HOOK_STATE_BODY, merged, re.M)
        merged = (merged[:existing.start()] + section + merged[existing.end():] if existing
                  else merged.rstrip("\n") + "\n\n" + section)
    merged = merged.rstrip("\n") + "\n"
    tomllib.loads(merged)
    return merged


def _atomic_write_text(target: Path, text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        st = None
    if st is not None and stat.S_ISLNK(st.st_mode):
        raise OSError(errno.ELOOP, "refusing to write through symlink", str(target))
    mode = stat.S_IMODE(st.st_mode) if st is not None else 0o644
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        for delay in (0.05, 0.1, 0.2, 0.4, 0.8):
            try:
                os.replace(tmp_name, target)
                break
            except PermissionError:
                if os.name != "nt" or delay == 0.8:
                    raise
                time.sleep(delay)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def sync_codex_mcp_servers(profile_home: Path, shared_home: Path) -> bool:
    """Sync shared MCP tables and hook trust state without replacing profile config."""
    source = shared_home / ".codex" / "config.toml"
    target = profile_home / ".codex" / "config.toml"
    try:
        source_text = source.read_text(encoding="utf-8")
        servers = tomllib.loads(source_text).get("mcp_servers")
        if not isinstance(servers, dict):
            return False
        replacement = _split_mcp_tables(source_text, None)[1].strip()
        if not replacement:
            return False
        source_hooks = source.parent / "hooks.json"
        profile_hooks = target.parent / "hooks.json"
        hook_sections = _hook_state_sections(source_text, source_hooks, profile_hooks)
        for _ in range(SYNC_ATTEMPTS):
            target_text = target.read_text(encoding="utf-8") if target.is_file() else ""
            merged = _merge_profile_config(target_text, replacement, frozenset(servers), hook_sections)
            if merged == target_text:
                break
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if current != target_text:
                continue
            _atomic_write_text(target, merged)
            break
        else:
            return False
        if source_hooks.is_file() and not profile_hooks.exists():
            try:
                profile_hooks.symlink_to(source_hooks)
            except OSError:
                # Keep the original's best-effort shared hook link semantics on platforms
                # where the user cannot create symlinks; MCP config itself remains synced.
                pass
        return True
    except (OSError, tomllib.TOMLDecodeError):
        return False


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: mcp_sync.py PROFILE_HOME SHARED_HOME")
    sync_codex_mcp_servers(Path(sys.argv[1]), Path(sys.argv[2]))
