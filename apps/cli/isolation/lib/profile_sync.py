#!/usr/bin/env python3
"""Synchronize approved native provider capabilities into bflow iso profiles."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
SCHEMA_VERSION = 1
MANAGED_PLUGIN = "bflow-superpowers@bflow-superpowers"
PLUGIN_NAME = "bflow-superpowers"
SECRET_KEYS = {
    "token", "secret", "password", "credential", "apikey", "api_key",
    "access_token", "refresh_token", "authorization", "oauth", "account",
    "email", "session",
}
MAX_FILE_BYTES = 16 * 1024 * 1024


class SyncError(Exception):
    pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SyncError("invalid synchronization command line")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _lexists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _assert_current_owner(path: Path) -> None:
    if os.name == "nt" or not hasattr(os, "getuid"):
        return
    try:
        owner = path.lstat().st_uid
    except OSError as exc:
        raise SyncError("unable to verify profile state ownership") from exc
    if owner != os.getuid():
        raise SyncError("profile state is not owned by the current user")


def _regular_file(path: Path) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SyncError("unsafe source or target file") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise SyncError("unsafe non-regular source or target")
        if st.st_size > MAX_FILE_BYTES:
            raise SyncError("source or target exceeds the 16 MiB limit")
        chunks: list[bytes] = []
        total = 0
        while True:
            part = os.read(fd, min(65536, MAX_FILE_BYTES + 1 - total))
            if not part:
                break
            chunks.append(part)
            total += len(part)
            if total > MAX_FILE_BYTES:
                raise SyncError("source or target exceeds the 16 MiB limit")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _safe_source_path(path: Path, roots: list[Path]) -> Path:
    resolved = path.resolve(strict=False)
    selected_root = next((root for root in roots
                          if _inside(resolved, root.resolve(strict=False))), None)
    if selected_root is None:
        raise SyncError("source path escapes the selected native configuration root")
    current = path
    while current != selected_root.parent:
        if _lexists(current) and current.is_symlink():
            raise SyncError("source symlinks are not supported")
        if current == selected_root:
            break
        current = current.parent
    return path


def _safe_target(target: Path, profile_home: Path) -> None:
    if not _inside(target, profile_home) or target == profile_home:
        raise SyncError("target path escapes the selected profile")
    current = profile_home
    if _lexists(current) and (current.is_symlink() or not current.is_dir()):
        raise SyncError("profile home is not a real directory")
    try:
        relative = target.relative_to(profile_home)
    except ValueError as exc:
        raise SyncError("target path escapes the selected profile") from exc
    for part in relative.parts:
        current = current / part
        if _lexists(current) and current.is_symlink():
            raise SyncError("target path contains a symlink")
        if _lexists(current) and current != target and not current.is_dir():
            raise SyncError("target parent is not a directory")


def _walk_assets(source: Path, target_root: Path, profile_home: Path, plan: dict[Path, bytes],
                 trusted_roots: list[Path]) -> None:
    if not _lexists(source):
        return
    if not source.is_dir():
        raise SyncError("managed asset source must be a real directory")
    source_real = source.resolve(strict=True)
    target_real = target_root.resolve(strict=False)
    if source_real == target_real or _inside(source_real, target_real) or _inside(target_real, source_real):
        raise SyncError("managed asset source overlaps its profile target")
    visited: set[Path] = set()

    def visit(directory: Path, relative: Path) -> None:
        canonical = directory.resolve(strict=True)
        if not any(_inside(canonical, root.resolve(strict=True)) for root in trusted_roots if root.exists()):
            raise SyncError("managed asset link escapes its trusted source root")
        if canonical in visited:
            raise SyncError("managed asset source contains a directory cycle")
        visited.add(canonical)
        try:
            for child in sorted(directory.iterdir()):
                if child.name in {".git", "__pycache__"}:
                    continue
                rel = relative / child.name
                if child.is_dir():
                    visit(child, rel)
                    continue
                if child.suffix in {".pyc", ".pyo"}:
                    continue
                target = target_root / rel
                _safe_target(target, profile_home)
                if child.is_symlink():
                    resolved = child.resolve(strict=True)
                    if not any(_inside(resolved, root.resolve(strict=True)) for root in trusted_roots if root.exists()):
                        raise SyncError("managed asset link escapes its trusted source root")
                    source_file = resolved
                else:
                    source_file = child
                if child.name in {".env", "auth.json", ".credentials.json"}:
                    continue
                raw = _regular_file(source_file)
                if raw is None:
                    raise SyncError("managed asset disappeared during inspection")
                plan[target] = raw
        finally:
            visited.remove(canonical)

    visit(source, Path())


def _read_json(path: Path, root: Path) -> dict[str, Any]:
    raw = _regular_file(_safe_source_path(path, [root]))
    if raw is None:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise SyncError("supported JSON configuration must be an object")
    return value


def _validate_claude_marketplace(entry: Any, install_location: Any = None) -> None:
    if not isinstance(entry, dict):
        raise SyncError("malformed managed Claude marketplace entry")
    source = entry.get("source")
    if not isinstance(source, dict) or source.get("source") != "directory" or not isinstance(source.get("path"), str):
        raise SyncError("unsupported managed Claude marketplace source")
    marketplace = Path(source["path"])
    if not marketplace.is_absolute():
        raise SyncError("managed Claude marketplace path must be absolute")
    paths = [marketplace]
    if install_location is not None:
        if not isinstance(install_location, str) or not Path(install_location).is_absolute():
            raise SyncError("managed Claude marketplace installLocation must be absolute")
        paths.append(Path(install_location))
    for path in paths:
        descriptor = _read_json(path / ".claude-plugin/marketplace.json", path)
        if descriptor.get("name") != PLUGIN_NAME:
            raise SyncError("managed Claude marketplace descriptor is missing or mismatched")


def _snapshot(value: Any, key: str = "") -> Any:
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()


def _merge_json_target(source: dict[str, Any], target: dict[str, Any], key: str,
                       previous: dict[str, Any], ownership_slot: str | None = None) -> dict[str, Any]:
    result = dict(target)
    incoming = source.get(key, {})
    existing = target.get(key, {})
    if not isinstance(incoming, dict) or not isinstance(existing, dict):
        raise SyncError(f"malformed {key} configuration")
    merged = dict(existing)
    slot = ownership_slot or key
    old = previous.get(slot, {})
    if not isinstance(old, dict):
        raise SyncError("malformed profile synchronization receipt")
    for name, value in incoming.items():
        if name in merged:
            prior = old.get(name)
            current_snapshot = _snapshot(merged[name])
            desired_snapshot = _snapshot(value)
            if prior is None and current_snapshot != desired_snapshot:
                raise SyncError("managed profile value conflicts with a local MCP entry")
            if prior is not None and current_snapshot not in (prior, desired_snapshot):
                raise SyncError("managed profile value changed locally; refusing to overwrite")
        merged[name] = value
    for name, prior in old.items():
        if name in incoming or name not in merged:
            continue
        if _snapshot(merged[name]) != prior:
            raise SyncError("managed profile value changed locally; refusing stale removal")
        del merged[name]
    previous[slot] = {name: _snapshot(value) for name, value in incoming.items()}
    result[key] = merged
    return result


def _merge_named_entry(target: dict[str, Any], source: dict[str, Any], key: str,
                       receipt: dict[str, Any], tag: str) -> dict[str, Any]:
    previous = receipt.setdefault("managedEntries", {})
    if not isinstance(previous, dict):
        raise SyncError("malformed profile synchronization receipt")
    result = dict(target)
    if key not in source:
        if tag in previous:
            if key in result and _snapshot(result[key]) != previous[tag]:
                raise SyncError("managed profile setting changed locally; refusing stale removal")
            result.pop(key, None)
            previous.pop(tag, None)
        return result
    incoming = source[key]
    desired = _snapshot(incoming)
    if key in result:
        current = _snapshot(result[key])
        prior = previous.get(tag)
        if prior is None and current != desired:
            raise SyncError("managed profile setting conflicts with a local entry")
        if prior is not None and current not in (prior, desired):
            raise SyncError("managed profile setting changed locally; refusing to overwrite")
    result[key] = incoming
    previous[tag] = desired
    return result


def _merge_managed_field(target: dict[str, Any], source_value: Any, key: str, field: str,
                         receipt: dict[str, Any], tag: str) -> dict[str, Any]:
    entries = receipt.setdefault("managedEntries", {})
    if not isinstance(entries, dict):
        raise SyncError("malformed profile synchronization receipt")
    result = dict(target)
    existing_value = result.get(key)
    if existing_value is not None and not isinstance(existing_value, dict):
        raise SyncError("malformed managed provider plugin state")
    entry = dict(existing_value or {})
    prior = entries.get(tag)
    if source_value is None:
        if prior is not None:
            if field in entry and _snapshot(entry[field]) != prior:
                raise SyncError("managed profile setting changed locally; refusing stale removal")
            entry.pop(field, None)
            entries.pop(tag, None)
    else:
        if not isinstance(source_value, bool):
            raise SyncError("managed plugin enabled state must be boolean")
        if field in entry:
            current = _snapshot(entry[field])
            desired = _snapshot(source_value)
            if prior is None and current != desired:
                raise SyncError("managed profile setting conflicts with a local entry")
            if prior is not None and current not in (prior, desired):
                raise SyncError("managed profile setting changed locally; refusing to overwrite")
        entry[field] = source_value
        entries[tag] = _snapshot(source_value)
    if entry:
        result[key] = entry
    else:
        result.pop(key, None)
    return result


def _merge_codex_managed_tables(target_text: str, source_text: str, prefix: str,
                                receipt: dict[str, Any], tag: str) -> str:
    existing = _toml_managed_tables(target_text, prefix)
    incoming = _toml_managed_tables(source_text, prefix)
    entries = receipt.setdefault("managedEntries", {})
    if not isinstance(entries, dict):
        raise SyncError("malformed profile synchronization receipt")
    prior = entries.get(tag)
    target_value = tomllib.loads(target_text) if target_text.strip() else {}
    source_value = tomllib.loads(source_text) if source_text.strip() else {}
    if prefix.startswith("plugins."):
        key, entry = "plugins", MANAGED_PLUGIN
    else:
        key, entry = "marketplaces", PLUGIN_NAME
    target_map = target_value.get(key, {})
    source_map = source_value.get(key, {})
    target_entry = target_map.get(entry) if isinstance(target_map, dict) else None
    source_entry = source_map.get(entry) if isinstance(source_map, dict) else None
    current_hash = _snapshot(target_entry) if existing else None
    desired_hash = _snapshot(source_entry) if incoming else None
    if existing and incoming:
        if prior is None and current_hash != desired_hash:
            raise SyncError("managed Codex plugin setting conflicts with a local entry")
        if prior is not None and current_hash not in (prior, desired_hash):
            raise SyncError("managed Codex plugin setting changed locally; refusing to overwrite")
    elif existing and prior is not None:
        if current_hash != prior:
            raise SyncError("managed Codex plugin setting changed locally; refusing stale removal")
    if existing:
        for block in existing:
            target_text = target_text.replace(block, "", 1)
    if incoming:
        entries[tag] = desired_hash
        target_text = target_text.rstrip() + ("\n\n" if target_text.strip() else "") + "\n".join(
            block.rstrip() for block in incoming
        ) + "\n"
    elif prior is not None:
        entries.pop(tag, None)
    target_text = re.sub(r"\n{3,}", "\n\n", target_text.strip())
    return target_text + ("\n" if target_text else "")


def _toml_managed_tables(text: str, prefix: str) -> list[str]:
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.match(r"^\s*\[\[?[^]]+\]?\]\s*(?:#.*)?$", line)]
    blocks: list[str] = []
    for pos, start in enumerate(starts):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(lines)
        header = lines[start].strip().lstrip("[").rstrip("]").lstrip("[")
        if header == prefix or header.startswith(prefix + "."):
            blocks.append("".join(lines[start:end]).rstrip() + "\n")
    return blocks


def _merge_codex(source_text: str, target_text: str, source_config: Path, target_config: Path,
                 previous: dict[str, Any]) -> str:
    source = tomllib.loads(source_text)
    target = tomllib.loads(target_text) if target_text.strip() else {}
    servers = source.get("mcp_servers", {})
    if not isinstance(servers, dict) or not isinstance(target.get("mcp_servers", {}), dict):
        raise SyncError("malformed Codex MCP tables")
    # Keep the existing synchronizer's parser/merge semantics for MCP and hook state.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import mcp_sync  # type: ignore[import-not-found]

    replacement = mcp_sync._split_mcp_tables(source_text, None)[1].strip()
    hook_sections = mcp_sync._hook_state_sections(
        source_text, source_config.parent / "hooks.json", target_config.parent / "hooks.json"
    )
    old_servers = previous.get("mcpServers", {})
    if not isinstance(old_servers, dict):
        raise SyncError("malformed profile synchronization receipt")
    target_servers = target.get("mcp_servers", {})
    for name, value in servers.items():
        if name in target_servers:
            current = _snapshot(target_servers[name])
            desired = _snapshot(value)
            prior = old_servers.get(name)
            if prior is None and current != desired:
                raise SyncError("managed profile value conflicts with a local Codex MCP entry")
            if prior is not None and current not in (prior, desired):
                raise SyncError("managed profile value changed locally; refusing to overwrite")
    for name, prior in old_servers.items():
        if name in servers or name not in target_servers:
            continue
        if _snapshot(target_servers[name]) != prior:
            raise SyncError("managed profile value changed locally; refusing stale removal")
    previous["mcpServers"] = {name: _snapshot(value) for name, value in servers.items()}
    managed_names = frozenset(set(servers) | set(old_servers))
    target_kept = mcp_sync._split_mcp_tables(target_text, managed_names)[0].rstrip()
    merged = (
        mcp_sync._merge_profile_config(target_kept, replacement, managed_names, hook_sections)
        if replacement or hook_sections or managed_names else target_kept + ("\n" if target_kept else "")
    )
    kept = merged.strip()
    kept = _merge_codex_managed_tables(
        kept, source_text, 'plugins."bflow-superpowers@bflow-superpowers"', previous, "codex.plugin"
    )
    return _merge_codex_managed_tables(
        kept, source_text, "marketplaces.bflow-superpowers", previous, "codex.marketplace"
    )


def _safe_target_parent(target: Path, profile_home: Path) -> None:
    if not _inside(target, profile_home) or target == profile_home:
        raise SyncError("target path escapes the selected profile")
    current = profile_home
    if current.is_symlink() or not current.is_dir():
        raise SyncError("profile home is not a real directory")
    for part in target.relative_to(profile_home).parts[:-1]:
        current = current / part
        if _lexists(current) and (current.is_symlink() or not current.is_dir()):
            raise SyncError("target parent is not a real directory")


def _link_destination(path: Path) -> Path | None:
    if not path.is_symlink():
        return None
    link = Path(os.readlink(path))
    if not link.is_absolute():
        link = path.parent / link
    return link.resolve(strict=False)


def _plan_codex_hooks_binding(profile_home: Path, source_home: Path,
                              receipt: dict[str, Any]) -> list[tuple[Path, Path | None, Path | None]]:
    source = _safe_source_path(source_home / "hooks.json", [source_home])
    raw = _regular_file(source)
    if raw is not None:
        try:
            json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SyncError("native Codex hooks.json is malformed") from exc
    target = profile_home / ".codex/hooks.json"
    _safe_target_parent(target, profile_home)
    entries = receipt.setdefault("managedEntries", {})
    if not isinstance(entries, dict):
        raise SyncError("malformed profile synchronization receipt")
    tag = "codex.hooksBinding"
    prior = entries.get(tag)
    if prior is not None and not isinstance(prior, str):
        raise SyncError("malformed profile synchronization receipt")
    current_link = _link_destination(target) if _lexists(target) else None

    if raw is not None:
        desired = source.resolve(strict=True)
        if current_link is not None:
            if current_link == desired:
                entries[tag] = str(desired)
                return [(target, desired, desired)]
            if prior is None or current_link != Path(prior):
                raise SyncError("Codex profile hooks.json has an unowned symlink")
            entries[tag] = str(desired)
            return [(target, desired, current_link)]
        if _lexists(target):
            if prior is not None:
                raise SyncError("managed Codex hooks binding was replaced locally")
            return []
        entries[tag] = str(desired)
        return [(target, desired, None)]

    if current_link is not None:
        if prior is None or current_link != Path(prior):
            raise SyncError("Codex profile hooks.json has an unowned symlink")
        entries.pop(tag, None)
        return [(target, None, current_link)]
    if _lexists(target) and prior is not None:
        raise SyncError("managed Codex hooks binding was replaced locally")
    entries.pop(tag, None)
    return []


def _contains_secret(value: Any, key: str = "") -> bool:
    normalized = re.sub(r"[^a-z]", "", key.lower())
    if any(marker in normalized for marker in SECRET_KEYS):
        return True
    if isinstance(value, dict):
        return any(_contains_secret(v, k) for k, v in value.items())
    if isinstance(value, list):
        return any(_contains_secret(v) for v in value)
    return False


def _redact_identity(value: Any, key: str | None = "") -> Any:
    key = key or ""
    normalized = re.sub(r"[^a-z]", "", key.lower())
    if any(marker in normalized for marker in SECRET_KEYS) or normalized in {"env", "headers", "httpheaders"}:
        if isinstance(value, dict):
            return {name: "<redacted>" for name in sorted(value)}
        return "<redacted>"
    if isinstance(value, dict):
        return {name: _redact_identity(item, name) for name, item in sorted(value.items())}
    if isinstance(value, list):
        return [_redact_identity(item) for item in value]
    return value


def _mcp_identity(servers: dict[str, Any]) -> dict[str, Any]:
    return {
        name: sorted(_shape_keys(config))
        for name, config in sorted(servers.items())
    }


def _shape_keys(value: Any, prefix: str = "") -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else key
            found.add(path)
            if isinstance(item, (dict, list)):
                found.update(_shape_keys(item, path))
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, (dict, list)):
                found.update(_shape_keys(item, prefix))
    return found


def _is_asset_path(path: Path) -> bool:
    parts = path.parts
    prefixes = (
        (".codex", "skills"), (".codex", "plugins", "cache"),
        (".claude", "skills"), (".claude", "plugins", "cache"),
        (".gemini", "config", "plugins"),
    )
    return any(tuple(parts[index:index + len(prefix)]) == prefix
               for prefix in prefixes for index in range(max(0, len(parts) - len(prefix) + 1)))


def _public_projection(path: Path, content: bytes) -> Any:
    if _is_asset_path(path):
        return {"assetSha256": hashlib.sha256(content).hexdigest()}
    name = path.name
    if name == "config.toml" and path.parent.name == ".codex":
        parsed = tomllib.loads(content.decode("utf-8"))
        projection = {}
        if isinstance(parsed.get("mcp_servers"), dict):
            projection["mcp_servers"] = _mcp_identity(parsed["mcp_servers"])
        plugins = parsed.get("plugins", {})
        if isinstance(plugins, dict) and MANAGED_PLUGIN in plugins:
            projection["plugins"] = {MANAGED_PLUGIN: plugins[MANAGED_PLUGIN]}
        marketplaces = parsed.get("marketplaces", {})
        if isinstance(marketplaces, dict) and PLUGIN_NAME in marketplaces:
            projection["marketplaces"] = {PLUGIN_NAME: marketplaces[PLUGIN_NAME]}
        return _redact_identity(projection)
    if name == "mcp_config.json" and path.parent.name == "config" and path.parent.parent.name == ".gemini":
        parsed = json.loads(content)
        servers = parsed.get("mcpServers", {})
        return {"mcpServers": _mcp_identity(servers) if isinstance(servers, dict) else {}}
    if (name == "config.json" and path.parent.name == "config"
            and path.parent.parent.name == ".gemini"):
        parsed = json.loads(content)
        plugin = parsed.get("plugins", {})
        managed = plugin.get(PLUGIN_NAME) if isinstance(plugin, dict) else None
        return {"plugins": {PLUGIN_NAME: {"enabled": managed["enabled"]}}
                if isinstance(managed, dict) and isinstance(managed.get("enabled"), bool) else {}}
    if (name == ".claude.json" and (path.parent.name == "home"
                                     or (path.parent.name == ".claude" and path.parent.parent.name == "home"))):
        parsed = json.loads(content)
        servers = parsed.get("mcpServers", {})
        return {"mcpServers": _mcp_identity(servers) if isinstance(servers, dict) else {}}
    if name == "settings.json" and path.parent.name == ".claude":
        parsed = json.loads(content)
        settings = {}
        for key in ("enabledPlugins", "extraKnownMarketplaces"):
            mapping = parsed.get(key, {})
            if isinstance(mapping, dict):
                expected = MANAGED_PLUGIN if key == "enabledPlugins" else PLUGIN_NAME
                if expected in mapping:
                    settings[key] = {expected: mapping[expected]}
        return _redact_identity(settings)
    if name in {"installed_plugins.json", "known_marketplaces.json"} and path.parent.name == "plugins":
        parsed = json.loads(content)
        key = "plugins" if name == "installed_plugins.json" else None
        managed = parsed.get(key, {}) if key else parsed
        if key:
            return _redact_identity({
                "version": parsed.get("version"),
                "plugins": {MANAGED_PLUGIN: managed[MANAGED_PLUGIN]}
                if isinstance(managed, dict) and MANAGED_PLUGIN in managed else {},
            })
        return _redact_identity({key: {MANAGED_PLUGIN: managed[MANAGED_PLUGIN]}
                                 if isinstance(managed, dict) and MANAGED_PLUGIN in managed else {}})
    return {"assetSha256": hashlib.sha256(content).hexdigest()}


def _identity_digest(plan: dict[Path, bytes]) -> str:
    digest = hashlib.sha256()
    for path, content in sorted(plan.items(), key=lambda item: str(item[0])):
        digest.update(str(path).encode())
        try:
            normalized = _json_bytes(_public_projection(path, content))
        except (ValueError, UnicodeDecodeError, tomllib.TOMLDecodeError):
            normalized = b"<invalid-public-projection>"
        digest.update(hashlib.sha256(normalized).digest())
    return digest.hexdigest()


def _atomic_write(path: Path, content: bytes, profile_home: Path) -> None:
    _safe_target(path, profile_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    _safe_target(path, profile_home)
    old_mode = stat.S_IMODE(path.lstat().st_mode) if _lexists(path) else 0o600
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        mode = 0o600 if path.name == ".bflow-profile-sync.json" else old_mode
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _profile_paths(provider: str, profile_home: Path, roots: dict[str, Path],
                   receipt: dict[str, Any]) -> tuple[dict[Path, bytes], list[tuple[Path, Path | None, Path | None]]]:
    plan: dict[Path, bytes] = {}
    links: list[tuple[Path, Path | None, Path | None]] = []
    native = roots[provider]
    if provider == "codex":
        src_config = _safe_source_path(native / "config.toml", [native])
        source_raw = _regular_file(src_config)
        target = profile_home / ".codex/config.toml"
        _safe_target(target, profile_home)
        target_raw = _regular_file(target)
        source_text = source_raw.decode("utf-8") if source_raw is not None else ""
        target_text = target_raw.decode("utf-8") if target_raw is not None else ""
        native_config: dict[str, Any] = {}
        if source_raw is not None or target_raw is not None or receipt.get("mcpServers") or receipt.get("managedEntries"):
            if source_text:
                native_config = tomllib.loads(source_text)
            merged_config = _merge_codex(source_text, target_text, src_config, target, receipt).encode()
            if source_raw is not None or target_raw is not None:
                plan[target] = merged_config
        codex_skills = roots.get("codex-skills", native / "skills")
        _walk_assets(codex_skills, profile_home / ".codex/skills", profile_home, plan, [native, codex_skills])
        plugin = native / "plugins/cache/bflow-superpowers"
        plugin_target = profile_home / ".codex/plugins/cache/bflow-superpowers"
        _walk_assets(plugin, plugin_target, profile_home, plan, [native])
        plugin_state = native_config.get("plugins", {})
        if not isinstance(plugin_state, dict):
            raise SyncError("malformed Codex plugin settings")
        managed_plugin = plugin_state.get(MANAGED_PLUGIN, {})
        if managed_plugin is not None and not isinstance(managed_plugin, dict):
            raise SyncError("malformed Codex Bflow plugin setting")
        if isinstance(managed_plugin, dict) and managed_plugin.get("enabled") is True:
            candidates = [
                (path, json.loads(content))
                for path, content in plan.items()
                if path.name == "plugin.json" and path.parent.name == ".codex-plugin"
            ]
            if not any(item.get("name") == PLUGIN_NAME for _, item in candidates):
                raise SyncError("enabled Codex Bflow plugin lacks its native manifest")
            if not any(path.name == "SKILL.md" and _inside(path, plugin_target) for path in plan):
                raise SyncError("enabled Codex Bflow plugin has no instruction entrypoint")
        links = _plan_codex_hooks_binding(profile_home, native, receipt)
    elif provider == "claude":
        source_root = roots["claude-config"]
        source_mcp_root = roots["claude-mcp-root"]
        source_mcp = _read_json(source_mcp_root / ".claude.json", source_mcp_root)
        target_mcp_path = profile_home / ".claude.json"
        _safe_target(target_mcp_path, profile_home)
        for target_mcp_path, ownership_slot in (
            (target_mcp_path, "claude.mcpServers.home"),
            (profile_home / ".claude/.claude.json", "claude.mcpServers.configDir"),
        ):
            _safe_target(target_mcp_path, profile_home)
            target_mcp = _read_json(target_mcp_path, profile_home)
            mcp_merged = _merge_json_target(
                source_mcp, target_mcp, "mcpServers", receipt.setdefault("managedEntries", {}), ownership_slot
            )
            if source_mcp or target_mcp:
                plan[target_mcp_path] = _json_bytes(mcp_merged)

        src_settings_path = source_root / "settings.json"
        src_settings = _read_json(src_settings_path, source_root)
        source_enabled = src_settings.get("enabledPlugins", {})
        if not isinstance(source_enabled, dict):
            raise SyncError("malformed Claude enabledPlugins")
        claude_plugin_enabled = source_enabled.get(MANAGED_PLUGIN) is True
        if MANAGED_PLUGIN in source_enabled and not isinstance(source_enabled[MANAGED_PLUGIN], bool):
            raise SyncError("Claude Bflow plugin enabled state must be boolean")
        target_settings_path = profile_home / ".claude/settings.json"
        _safe_target(target_settings_path, profile_home)
        target_settings = _read_json(target_settings_path, profile_home)
        settings = dict(target_settings)
        known_source = src_settings.get("extraKnownMarketplaces", {})
        if isinstance(known_source, dict) and PLUGIN_NAME in known_source:
            _validate_claude_marketplace(known_source[PLUGIN_NAME])
        for key in ("enabledPlugins", "extraKnownMarketplaces"):
            incoming = src_settings.get(key, {})
            existing = target_settings.get(key, {})
            if not isinstance(incoming, dict) or not isinstance(existing, dict):
                raise SyncError(f"malformed Claude {key}")
            managed_key = MANAGED_PLUGIN if key == "enabledPlugins" else PLUGIN_NAME
            merged = _merge_named_entry(existing, incoming, managed_key, receipt, f"claude.settings.{key}")
            if merged:
                settings[key] = merged
            else:
                settings.pop(key, None)
        if src_settings or target_settings:
            plan[target_settings_path] = _json_bytes(settings)
        _walk_assets(source_root / "skills", profile_home / ".claude/skills", profile_home, plan,
                     [source_root, roots["source-home"]])
        _walk_assets(source_root / "plugins/cache/bflow-superpowers",
                     profile_home / ".claude/plugins/cache/bflow-superpowers", profile_home, plan,
                     [source_root, roots["source-home"]])

        for filename, map_key in (("installed_plugins.json", "plugins"), ("known_marketplaces.json", None)):
            src_registry = source_root / "plugins" / filename
            source_registry = _read_json(src_registry, source_root)
            managed_tag = f"claude.registry.{filename}"
            if filename == "installed_plugins.json" and claude_plugin_enabled and not source_registry:
                raise SyncError("enabled Claude Bflow plugin lacks its discovery registry")
            if not source_registry and managed_tag not in receipt.get("managedEntries", {}):
                continue
            target_registry_path = profile_home / ".claude/plugins" / filename
            _safe_target(target_registry_path, profile_home)
            target_registry = _read_json(target_registry_path, profile_home)
            if map_key:
                source_map = source_registry.get(map_key, {})
                target_map = target_registry.get(map_key, {})
                if not isinstance(source_map, dict) or not isinstance(target_map, dict):
                    raise SyncError("malformed Claude plugin registry")
                sanitized_source: dict[str, Any] = {}
                if MANAGED_PLUGIN in source_map:
                    if source_registry.get("version") != 2:
                        raise SyncError("unsupported Claude installed plugin registry version")
                    if "version" in target_registry and target_registry["version"] != 2:
                        raise SyncError("conflicting Claude installed plugin registry version")
                    values = source_map[MANAGED_PLUGIN]
                    if not isinstance(values, list) or any(not isinstance(row, dict) for row in values):
                        raise SyncError("malformed managed Claude plugin registry entry")
                    if claude_plugin_enabled and not values:
                        raise SyncError("enabled Claude Bflow plugin has no installed registry entry")
                    sanitized = []
                    for row in values:
                        item = {k: v for k, v in row.items() if k in {"scope", "version", "installedAt", "lastUpdated"}}
                        if "installPath" in row:
                            source_cache = source_root / "plugins/cache/bflow-superpowers"
                            source_install = Path(str(row["installPath"]))
                            if not source_install.is_absolute():
                                source_install = source_root / source_install
                            source_install = source_install.resolve(strict=True)
                            if not _inside(source_install, source_cache.resolve(strict=True)):
                                raise SyncError("managed Claude plugin installPath escapes its verified cache")
                            relative_install = source_install.relative_to(source_cache.resolve(strict=True))
                            target_install = profile_home / ".claude/plugins/cache/bflow-superpowers" / relative_install
                            manifest = _read_json(source_install / ".claude-plugin/plugin.json", source_install)
                            if manifest.get("name") != PLUGIN_NAME:
                                raise SyncError("managed Claude plugin installPath lacks its native manifest")
                            item["installPath"] = str(target_install)
                            if claude_plugin_enabled and not any(
                                path.name == "SKILL.md" and _inside(path, target_install) for path in plan
                            ):
                                raise SyncError("enabled Claude Bflow plugin has no instruction entrypoint")
                        sanitized.append(item)
                    if claude_plugin_enabled and not any("installPath" in row for row in values):
                        raise SyncError("enabled Claude Bflow plugin has no verified installPath")
                    sanitized_source[MANAGED_PLUGIN] = sanitized
                elif claude_plugin_enabled:
                    raise SyncError("enabled Claude Bflow plugin is absent from its discovery registry")
                merged_map = _merge_named_entry(target_map, sanitized_source, MANAGED_PLUGIN, receipt, managed_tag)
                registry = dict(target_registry)
                if MANAGED_PLUGIN in source_map:
                    registry["version"] = 2
                registry[map_key] = merged_map
            else:
                sanitized_source = {}
                if PLUGIN_NAME in source_registry:
                    entry = source_registry[PLUGIN_NAME]
                    if not isinstance(entry, dict):
                        raise SyncError("malformed Claude marketplace registry entry")
                    _validate_claude_marketplace(entry, entry.get("installLocation"))
                    sanitized_source[PLUGIN_NAME] = {
                        k: v for k, v in entry.items() if k in {"source", "lastUpdated", "installLocation"}
                    }
                registry = _merge_named_entry(target_registry, sanitized_source, PLUGIN_NAME, receipt, managed_tag)
            plan[target_registry_path] = _json_bytes(registry)
    else:
        source_config = native / "config/mcp_config.json"
        source_mcp = _read_json(source_config, native)
        target_mcp_path = profile_home / ".gemini/config/mcp_config.json"
        _safe_target(target_mcp_path, profile_home)
        target_mcp = _read_json(target_mcp_path, profile_home)
        merged = _merge_json_target(source_mcp, target_mcp, "mcpServers", receipt)
        if source_mcp or target_mcp:
            plan[target_mcp_path] = _json_bytes(merged)
        plugin_root = native / "config/plugins/bflow-superpowers"
        plugin_target = profile_home / ".gemini/config/plugins/bflow-superpowers"
        source_state = _read_json(native / "config/config.json", native)
        source_plugins = source_state.get("plugins", {})
        if not isinstance(source_plugins, dict):
            raise SyncError("malformed Agy plugin state")
        source_plugin = source_plugins.get(PLUGIN_NAME)
        if source_plugin is not None and not isinstance(source_plugin, dict):
            raise SyncError("malformed Agy Bflow plugin state")
        has_plugin_assets = _lexists(plugin_root)
        enabled: bool | None
        if isinstance(source_plugin, dict) and "enabled" in source_plugin:
            enabled = source_plugin["enabled"]
        elif has_plugin_assets or f"agy.config.plugins.{PLUGIN_NAME}.enabled" in receipt.get("managedEntries", {}):
            enabled = True
        else:
            enabled = None

        plugin_plan: dict[Path, bytes] = {}
        _walk_assets(plugin_root, plugin_target, profile_home, plugin_plan,
                     [native, roots["source-home"]])
        if enabled is True:
            manifest_path = plugin_root / ".antigravity-plugin/plugin.json"
            manifest = _read_json(manifest_path, plugin_root)
            if manifest.get("name") != PLUGIN_NAME or not manifest.get("skills"):
                raise SyncError("enabled Agy Bflow plugin lacks its native manifest or skills")
            if not any(path.name == "SKILL.md" and _inside(path, plugin_target) for path in plugin_plan):
                raise SyncError("enabled Agy Bflow plugin has no instruction entrypoint")
        plan.update(plugin_plan)

        target_state_path = profile_home / ".gemini/config/config.json"
        _safe_target(target_state_path, profile_home)
        target_state = _read_json(target_state_path, profile_home)
        target_plugins = target_state.get("plugins", {})
        if not isinstance(target_plugins, dict):
            raise SyncError("malformed profile Agy plugin state")
        merged_plugins = _merge_managed_field(
            target_plugins, enabled, PLUGIN_NAME, "enabled", receipt,
            f"agy.config.plugins.{PLUGIN_NAME}.enabled",
        )
        if merged_plugins != target_plugins:
            target_state["plugins"] = merged_plugins
            plan[target_state_path] = _json_bytes(target_state)
    return plan, links


def _profile_home(profile_base: Path, provider: str, name: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise SyncError("invalid profile name")
    root = profile_base / f"{provider}--{name}"
    home = root / "home"
    for path in (profile_base, root, home):
        if _lexists(path) and (path.is_symlink() or not path.is_dir()):
            raise SyncError("profile root and home must be real directories")
        if _lexists(path):
            _assert_current_owner(path)
    if not _lexists(home) or not _inside(home.resolve(strict=True), profile_base.resolve(strict=True)):
        raise SyncError("explicit profile does not exist or escapes state root")
    metadata = _regular_file(root / "profile.env")
    if metadata is None:
        raise SyncError("profile metadata is missing")
    _assert_current_owner(root / "profile.env")
    values: dict[str, str] = {}
    for line in metadata.decode("utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    if values.get("AI_ISOLATOR_TOOL") != provider or values.get("AI_ISOLATOR_PROFILE") != name:
        raise SyncError("profile metadata does not match the selected provider and name")
    return home


def _load_receipt(profile_root: Path, provider: str) -> dict[str, Any]:
    path = profile_root / ".bflow-profile-sync.json"
    raw = _regular_file(path)
    if raw is None:
        return {"schemaVersion": SCHEMA_VERSION, "provider": provider, "mcpServers": {}, "assets": {}, "managedEntries": {}}
    _assert_current_owner(path)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise SyncError("profile synchronization receipt is malformed") from exc
    if (not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION
            or value.get("provider") != provider or not isinstance(value.get("mcpServers"), dict)
            or not isinstance(value.get("assets"), dict)
            or not isinstance(value.get("managedEntries", {}), dict)):
        raise SyncError("profile synchronization receipt is malformed")
    return value


def _is_asset_target(target: Path, home: Path) -> bool:
    relative = target.relative_to(home).as_posix()
    return any(relative.startswith(prefix) for prefix in (
        ".codex/skills/", ".codex/plugins/cache/bflow-superpowers/",
        ".claude/skills/", ".claude/plugins/cache/bflow-superpowers/",
        ".gemini/config/plugins/bflow-superpowers/",
    ))


def _prepare_profile_receipt(plan: dict[Path, bytes], home: Path, profile_root: Path,
                             provider: str, receipt: dict[str, Any]) -> tuple[Path, bytes, list[Path]]:
    old_assets = receipt.get("assets", {})
    if not isinstance(old_assets, dict):
        raise SyncError("malformed profile synchronization receipt")
    new_assets: dict[str, str] = {}
    asset_plan = {path: content for path, content in plan.items() if _is_asset_target(path, home)}
    for path, content in asset_plan.items():
        relative = path.relative_to(home).as_posix()
        old_digest = old_assets.get(relative)
        current = _regular_file(path)
        if current != content and current is not None:
            if old_digest is None or hashlib.sha256(current).hexdigest() != old_digest:
                raise SyncError("managed asset changed locally; refusing to overwrite")
        new_assets[relative] = hashlib.sha256(content).hexdigest()

    stale: list[Path] = []
    for relative, old_digest in old_assets.items():
        relpath = Path(relative)
        if relpath.is_absolute() or ".." in relpath.parts or not isinstance(old_digest, str):
            raise SyncError("malformed profile synchronization receipt")
        path = home / relpath
        if path in asset_plan:
            continue
        _safe_target(path, home)
        current = _regular_file(path)
        if current is None:
            continue
        if hashlib.sha256(current).hexdigest() != old_digest:
            raise SyncError("managed asset changed locally; refusing stale removal")
        stale.append(path)

    receipt["schemaVersion"] = SCHEMA_VERSION
    receipt["provider"] = provider
    receipt.setdefault("mcpServers", {})
    receipt.setdefault("managedEntries", {})
    receipt["assets"] = new_assets
    receipt_path = profile_root / ".bflow-profile-sync.json"
    receipt_bytes = _json_bytes(receipt)
    return receipt_path, receipt_bytes, stale


def _binding_matches(target: Path, source: Path | None) -> bool:
    if source is None:
        return not _lexists(target)
    return target.is_symlink() and _link_destination(target) == source.resolve(strict=False)


def _apply_binding(target: Path, source: Path | None, expected_current: Path | None,
                   profile_home: Path) -> bool:
    _safe_target_parent(target, profile_home)
    target.parent.mkdir(parents=True, exist_ok=True)
    _safe_target_parent(target, profile_home)
    current_exists = _lexists(target)
    current = _link_destination(target) if current_exists and target.is_symlink() else None
    if source is None:
        if not current_exists:
            return False
        if current is None or current != expected_current:
            raise SyncError("Codex hooks binding changed during synchronization")
        target.unlink()
        return True
    source = source.resolve(strict=True)
    if current_exists and current == source:
        return False
    if expected_current is None:
        if current_exists:
            raise SyncError("Codex hooks target changed during synchronization")
    elif current != expected_current:
        raise SyncError("Codex hooks binding changed during synchronization")

    fd, temp_name = tempfile.mkstemp(prefix=".hooks.json.", suffix=".tmp", dir=target.parent)
    os.close(fd)
    os.unlink(temp_name)
    try:
        os.symlink(source, temp_name)
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return True


def _main() -> int:
    parser = JsonArgumentParser(add_help=False)
    parser.add_argument("mode", choices=("inspect", "apply"))
    parser.add_argument("--source-home", required=True, type=Path)
    parser.add_argument("--state-root", required=True, type=Path)
    parser.add_argument("--source-codex-home", type=Path)
    parser.add_argument("--source-claude-config-dir", type=Path)
    parser.add_argument("--source-codex-skills", type=Path)
    parser.add_argument("--provider", choices=("codex", "claude", "agy"))
    parser.add_argument("--profile")
    args = parser.parse_args()
    if bool(args.provider) != bool(args.profile):
        raise SyncError("--provider and --profile must be specified together")
    for path in (args.source_home, args.state_root, args.source_codex_home,
                 args.source_claude_config_dir, args.source_codex_skills):
        if path is not None and not path.is_absolute():
            raise SyncError("all path arguments must be absolute")
    roots = {
        "codex": args.source_codex_home or args.source_home / ".codex",
        "claude": args.source_claude_config_dir or args.source_home / ".claude",
        "claude-config": args.source_claude_config_dir or args.source_home / ".claude",
        "claude-mcp-root": args.source_claude_config_dir or args.source_home,
        "source-home": args.source_home,
        "agy": args.source_home / ".gemini",
    }
    # Explicit skills source takes precedence over the normal native Codex location.
    if args.source_codex_skills:
        roots["codex-skills"] = args.source_codex_skills
    profile_base = args.state_root / "profiles"
    if _lexists(args.state_root):
        if args.state_root.is_symlink() or not args.state_root.is_dir():
            raise SyncError("state root must be a real directory")
        _assert_current_owner(args.state_root)
    if _lexists(profile_base):
        if profile_base.is_symlink() or not profile_base.is_dir():
            raise SyncError("profile directory must be a real directory")
        _assert_current_owner(profile_base)
    if args.provider:
        profile_home = _profile_home(profile_base, args.provider, args.profile)
        selected = [(args.provider, args.profile, profile_home)]
    else:
        selected = []
        if _lexists(profile_base):
            for provider in ("codex", "claude", "agy"):
                for entry in sorted(profile_base.glob(f"{provider}--*")):
                    if _lexists(entry):
                        if entry.is_symlink() or not entry.is_dir():
                            raise SyncError("profile root and home must be real directories")
                        name = entry.name[len(provider) + 2:]
                        selected.append((provider, name, _profile_home(profile_base, provider, name)))

    plans: list[tuple[str, str, Path, Path, dict[Path, bytes],
                       list[tuple[Path, Path | None, Path | None]], bytes, list[Path]]] = []
    all_targets: list[str] = []
    desired_material: dict[Path, bytes] = {}
    for provider, name, home in selected:
        if home.resolve() == args.source_home.resolve():
            raise SyncError("source and profile homes must be distinct")
        profile_root = home.parent
        receipt = _load_receipt(profile_root, provider)
        plans_for_profile, links = _profile_paths(provider, home, roots, receipt)
        receipt_path, receipt_bytes, stale_assets = _prepare_profile_receipt(
            plans_for_profile, home, profile_root, provider, receipt
        )
        plans.append((provider, name, home, profile_root, plans_for_profile, links, receipt_bytes, stale_assets))
        desired_material.update(plans_for_profile)
        all_targets.append(str(home.resolve()))

    desired_digest = _identity_digest(desired_material)
    owned_paths: list[str] = []
    valid = True
    for _, _, home, profile_root, plan, links, receipt_bytes, stale_assets in plans:
        for target, content in plan.items():
            _safe_target(target, home)
            current = _regular_file(target)
            if current != content:
                valid = False
                if args.mode == "apply":
                    if _regular_file(target) != current:
                        raise SyncError("profile target changed during synchronization")
                    _atomic_write(target, content, home)
                    if _regular_file(target) != content:
                        raise SyncError("atomic write read-back mismatch")
                    owned_paths.append(str(target))
        for target in stale_assets:
            if args.mode == "apply":
                _safe_target(target, home)
                target.unlink()
                owned_paths.append(str(target))
        for target, source, expected_current in links:
            if args.mode == "apply" and _apply_binding(target, source, expected_current, home):
                owned_paths.append(str(target))
        receipt_path = profile_root / ".bflow-profile-sync.json"
        current_receipt = _regular_file(receipt_path)
        receipt_mode = stat.S_IMODE(receipt_path.lstat().st_mode) if _lexists(receipt_path) else None
        if current_receipt != receipt_bytes or receipt_mode != 0o600:
            valid = False
            if args.mode == "apply":
                if _regular_file(receipt_path) != current_receipt:
                    raise SyncError("profile receipt changed during synchronization")
                _atomic_write(receipt_path, receipt_bytes, profile_root)
                owned_paths.append(str(receipt_path))
    valid = all(
        _regular_file(target) == content
        for _, _, home, _, plan, _, _, stale_assets in plans
        for target, content in plan.items()
    ) and all(
        not _lexists(target)
        for _, _, _, _, _, _, _, stale_assets in plans
        for target in stale_assets
    ) and all(
        _regular_file(profile_root / ".bflow-profile-sync.json") == receipt_bytes
        for _, _, _, profile_root, _, _, receipt_bytes, _ in plans
    ) and all(
        stat.S_IMODE((profile_root / ".bflow-profile-sync.json").lstat().st_mode) == 0o600
        for _, _, _, profile_root, _, _, _, _ in plans
    ) and all(
        _binding_matches(target, source)
        for _, _, _, _, _, links, _, _ in plans
        for target, source, _ in links
    )
    state_digest = desired_digest if valid else None
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "valid": valid,
        "desiredDigest": desired_digest,
        "stateDigest": state_digest,
        "profileCount": len(selected),
        "targets": sorted(set(all_targets)),
        "ownedPaths": sorted(set(owned_paths)),
        "diagnostics": [],
    }
    print(json.dumps(report, separators=(",", ":")))
    return 0 if valid or args.mode == "inspect" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except BaseException as exc:
        if isinstance(exc, SystemExit):
            raise
        print(json.dumps({
            "schemaVersion": SCHEMA_VERSION,
            "valid": False,
            "desiredDigest": "0" * 64,
            "stateDigest": None,
            "profileCount": 0,
            "targets": [],
            "ownedPaths": [],
            "diagnostics": [str(exc) if isinstance(exc, SyncError) else f"invalid or unsafe synchronization input ({type(exc).__name__})"],
        }, separators=(",", ":")))
        raise SystemExit(1)
