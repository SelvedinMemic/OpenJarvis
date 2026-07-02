"""System information tool — read-only local machine facts."""

from __future__ import annotations

import ctypes
import getpass
import json
import os
import platform
import socket
from pathlib import Path
from typing import Any, Dict

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec


def _total_ram_gb() -> float:
    """Return total physical RAM in GiB when available."""
    if os.name != "nt":
        return 0.0

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return 0.0
    return round(status.ullTotalPhys / (1024**3), 2)


@ToolRegistry.register("system_info")
class SystemInfoTool(BaseTool):
    """Return local system details without network access."""

    tool_id = "system_info"
    is_local = True

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="system_info",
            description=(
                "Return read-only local system information such as OS, CPU, "
                "memory, hostname, user and working directory."
            ),
            parameters={"type": "object", "properties": {}},
            category="system",
        )

    def execute(self, **params: Any) -> ToolResult:
        info: Dict[str, Any] = {
            "hostname": socket.gethostname(),
            "fqdn": socket.getfqdn(),
            "user": getpass.getuser(),
            "cwd": str(Path.cwd()),
            "platform": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "python_version": platform.python_version(),
            "cpu_count": os.cpu_count() or 0,
            "total_ram_gb": _total_ram_gb(),
        }

        return ToolResult(
            tool_name="system_info",
            content=json.dumps(info, ensure_ascii=False),
            success=True,
            metadata=info,
        )
