"""Application launcher tool — start local apps or open URLs."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
import webbrowser
from pathlib import Path
from typing import Any, List

if os.name == "nt":
    import winreg


_APP_CATALOG_TTL_SECONDS = 180.0
_APP_CATALOG_CACHE: dict[str, Any] = {
    "built_at": 0.0,
    "aliases": {},
}


def _alias_keys(name: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    if not cleaned:
        return []
    keys = {cleaned, cleaned.replace(" ", "")}
    return [k for k in keys if k]


def _remember_alias(aliases: dict[str, dict[str, str]], name: str, launch_target: str) -> None:
    for key in _alias_keys(name):
        aliases.setdefault(key, {"name": name, "target": launch_target})


def _scan_start_menu_shortcuts(aliases: dict[str, dict[str, str]]) -> None:
    roots = [
        Path(os.environ.get("ProgramData", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
        Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
    ]
    for root in roots:
        if not root.exists():
            continue
        for ext in ("*.lnk", "*.url"):
            for shortcut in root.rglob(ext):
                _remember_alias(aliases, shortcut.stem, str(shortcut))


def _scan_registry_apps(aliases: dict[str, dict[str, str]]) -> None:
    if os.name != "nt":
        return

    reg_roots: list[tuple[int, str]] = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for hive, root_key in reg_roots:
        try:
            with winreg.OpenKey(hive, root_key) as root:
                count = winreg.QueryInfoKey(root)[0]
                for i in range(count):
                    sub_name = winreg.EnumKey(root, i)
                    try:
                        with winreg.OpenKey(root, sub_name) as app_key:
                            display_name = winreg.QueryValueEx(app_key, "DisplayName")[0]
                            if not isinstance(display_name, str) or not display_name.strip():
                                continue
                            display_icon = ""
                            install_location = ""
                            try:
                                display_icon = str(winreg.QueryValueEx(app_key, "DisplayIcon")[0])
                            except OSError:
                                pass
                            try:
                                install_location = str(winreg.QueryValueEx(app_key, "InstallLocation")[0])
                            except OSError:
                                pass

                            candidate = ""
                            if display_icon:
                                candidate = display_icon.split(",", 1)[0].strip('" ')
                            if (not candidate or not Path(candidate).exists()) and install_location:
                                loc = Path(install_location)
                                if loc.exists() and loc.is_dir():
                                    exes = list(loc.glob("*.exe"))
                                    if exes:
                                        candidate = str(exes[0])
                            if candidate and Path(candidate).exists():
                                _remember_alias(aliases, display_name, candidate)
                    except OSError:
                        continue
        except OSError:
            continue


def _windows_app_catalog(force_refresh: bool = False) -> dict[str, dict[str, str]]:
    if os.name != "nt":
        return {}

    now = time.time()
    built_at = float(_APP_CATALOG_CACHE.get("built_at", 0.0) or 0.0)
    if not force_refresh and (now - built_at) < _APP_CATALOG_TTL_SECONDS:
        aliases = _APP_CATALOG_CACHE.get("aliases", {})
        return aliases if isinstance(aliases, dict) else {}

    aliases: dict[str, dict[str, str]] = {}
    _scan_start_menu_shortcuts(aliases)
    _scan_registry_apps(aliases)
    _APP_CATALOG_CACHE["built_at"] = now
    _APP_CATALOG_CACHE["aliases"] = aliases
    return aliases


def _resolve_windows_installed_app(target: str, *, force_refresh: bool = False) -> str | None:
    aliases = _windows_app_catalog(force_refresh=force_refresh)
    for key in _alias_keys(target):
        hit = aliases.get(key)
        if hit:
            path = hit.get("target", "")
            if path:
                return path

    # Fuzzy fallback: allow partial key matches for noisy tool-call targets.
    needle = re.sub(r"[^a-z0-9]+", "", target.lower())
    if needle:
        for key, hit in aliases.items():
            key_norm = re.sub(r"[^a-z0-9]+", "", key)
            if needle in key_norm or key_norm in needle:
                path = hit.get("target", "")
                if path:
                    return path
    return None


def _target_variants(target: str) -> list[str]:
    """Generate cleaned target variants from noisy LLM output."""
    variants: list[str] = []

    def add(value: str) -> None:
        value = value.strip(" \t\n\r,.;:!?()[]{}\"'")
        if value and value not in variants:
            variants.append(value)

    base = target.strip()
    add(base)

    # Drop content after separators often found in summarized snippets.
    head = re.split(r"[,;]|\.{3}|…", base, maxsplit=1)[0].strip()
    add(head)

    lowered = head.lower()
    for prefix in (
        "oeffne ",
        "öffne ",
        "open ",
        "start ",
        "launch ",
        "app ",
        "programm ",
        "program ",
        "target ",
        "t ",
    ):
        if lowered.startswith(prefix):
            add(head[len(prefix) :])

    tokens = head.split()
    if len(tokens) >= 2 and len(tokens[0]) == 1:
        add(" ".join(tokens[1:]))

    return variants

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec


def _windows_browser_candidates(browser: str) -> list[str]:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("ProgramFiles", "")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", "")

    if browser == "chrome":
        return [
            os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(program_files, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(program_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
        ]
    if browser == "edge":
        return [
            os.path.join(program_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(program_files, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
    if browser == "firefox":
        return [
            os.path.join(program_files, "Mozilla Firefox", "firefox.exe"),
            os.path.join(program_files_x86, "Mozilla Firefox", "firefox.exe"),
        ]
    return []


def _normalize_target(target: str, arguments: list[str]) -> tuple[str, list[str]]:
    normalized = target.strip()
    lowered = normalized.lower()

    browser_map = {
        "chrome": ["chrome", "google chrome", "chrome browser", "chrome-browser", "chrom"],
        "edge": ["edge", "microsoft edge", "edge browser"],
        "firefox": ["firefox", "mozilla firefox", "fire fox"],
    }

    for browser, aliases in browser_map.items():
        if lowered in aliases:
            return browser, arguments

    if any(token in lowered for token in ["neuen tab", "new tab", "tab oeffnen", "tab öffnen"]):
        return "chrome", ["--new-tab", *arguments]

    if lowered.startswith(("oeffne ", "öffne ")):
        tail = lowered.replace("oeffne ", "", 1).replace("öffne ", "", 1).strip()
        for browser, aliases in browser_map.items():
            if tail in aliases:
                return browser, arguments

    return normalized, arguments


@ToolRegistry.register("app_launch")
class AppLaunchTool(BaseTool):
    """Launch a local application, open a file, or open a URL."""

    tool_id = "app_launch"
    is_local = True

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="app_launch",
            description=(
                "Launch a local application, open a file, or open a URL on "
                "the user's machine."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Application name, executable path, file path, or URL.",
                    },
                    "arguments": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional command-line arguments.",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional working directory.",
                    },
                    "refresh_catalog": {
                        "type": "boolean",
                        "description": (
                            "Force a Windows installed-app catalog refresh before "
                            "resolving the target."
                        ),
                    },
                },
                "required": ["target"],
            },
            category="system",
            timeout_seconds=15.0,
        )

    def execute(self, **params: Any) -> ToolResult:
        target = str(params.get("target", "")).strip()
        if not target:
            return ToolResult(
                tool_name="app_launch",
                content="No target provided.",
                success=False,
            )

        arguments: List[str] = [str(arg) for arg in params.get("arguments", []) or []]
        refresh_catalog = bool(params.get("refresh_catalog", False))
        cwd = str(params.get("cwd", "")).strip() or None
        target, arguments = _normalize_target(target, arguments)

        if target.startswith(("http://", "https://")):
            opened = webbrowser.open(target)
            return ToolResult(
                tool_name="app_launch",
                content=f"Opened URL: {target}" if opened else f"Failed to open URL: {target}",
                success=opened,
                metadata={"target": target, "type": "url"},
            )

        path = Path(target)
        if path.exists():
            try:
                os.startfile(str(path))  # type: ignore[attr-defined]
                return ToolResult(
                    tool_name="app_launch",
                    content=f"Launched: {target}",
                    success=True,
                    metadata={"target": target, "type": "path"},
                )
            except Exception as exc:
                return ToolResult(
                    tool_name="app_launch",
                    content=f"Failed to launch path '{target}': {exc}",
                    success=False,
                )

        resolved = None
        for candidate_target in _target_variants(target):
            resolved = shutil.which(candidate_target)
            if resolved:
                target = candidate_target
                break
        resolved_is_shortcut = False
        if not resolved and os.name == "nt":
            for candidate_target in _target_variants(target):
                resolved = _resolve_windows_installed_app(
                    candidate_target,
                    force_refresh=refresh_catalog,
                )
                if resolved:
                    target = candidate_target
                    if Path(resolved).suffix.lower() in {".lnk", ".url"}:
                        resolved_is_shortcut = True
                    break
        if not resolved and os.name == "nt":
            for candidate in _windows_browser_candidates(target.lower()):
                if candidate and Path(candidate).exists():
                    resolved = candidate
                    break
        if resolved:
            try:
                if os.name == "nt" and resolved_is_shortcut:
                    os.startfile(resolved)  # type: ignore[attr-defined]
                    proc = None
                else:
                    proc = subprocess.Popen([resolved, *arguments], cwd=cwd)
                return ToolResult(
                    tool_name="app_launch",
                    content=f"Launched: {target}",
                    success=True,
                    metadata={
                        "target": target,
                        "resolved": resolved,
                        "pid": proc.pid if proc else None,
                        "arguments": arguments,
                        "cwd": cwd,
                    },
                )
            except Exception as exc:
                return ToolResult(
                    tool_name="app_launch",
                    content=f"Failed to launch '{target}': {exc}",
                    success=False,
                )

        if os.name == "nt" and not refresh_catalog:
            refreshed = None
            for candidate_target in _target_variants(target):
                refreshed = _resolve_windows_installed_app(
                    candidate_target,
                    force_refresh=True,
                )
                if refreshed:
                    target = candidate_target
                    break
            if refreshed:
                try:
                    if Path(refreshed).suffix.lower() in {".lnk", ".url"}:
                        os.startfile(refreshed)  # type: ignore[attr-defined]
                        pid = None
                    else:
                        proc = subprocess.Popen([refreshed, *arguments], cwd=cwd)
                        pid = proc.pid
                    return ToolResult(
                        tool_name="app_launch",
                        content=f"Launched: {target}",
                        success=True,
                        metadata={
                            "target": target,
                            "resolved": refreshed,
                            "pid": pid,
                            "arguments": arguments,
                            "cwd": cwd,
                            "catalog_refreshed": True,
                        },
                    )
                except Exception as exc:
                    return ToolResult(
                        tool_name="app_launch",
                        content=f"Failed to launch '{target}' after catalog refresh: {exc}",
                        success=False,
                    )

        return ToolResult(
            tool_name="app_launch",
            content=(
                f"Could not find an executable for '{target}'. Provide a full path "
                "or install it in PATH."
            ),
            success=False,
        )
