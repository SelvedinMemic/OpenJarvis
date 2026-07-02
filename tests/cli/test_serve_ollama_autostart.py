"""Tests for Ollama auto-start fallback in ``jarvis serve``."""

from __future__ import annotations

from rich.console import Console

from openjarvis.cli.serve import _maybe_autostart_local_ollama
from openjarvis.core.config import JarvisConfig


class _DummyConsole(Console):
    def __init__(self) -> None:
        super().__init__(record=True)


def test_autostart_local_ollama_when_unreachable(monkeypatch) -> None:
    cfg = JarvisConfig()
    cfg.engine.default = "ollama"
    cfg.engine.ollama.host = "http://localhost:11434"

    calls = {"start": 0}
    states = iter([False, True])

    monkeypatch.setattr("openjarvis.cli.serve._ollama_reachable", lambda _h: next(states))

    def _start(_host: str) -> bool:
        calls["start"] += 1
        return True

    monkeypatch.setattr("openjarvis.cli.serve._start_ollama_process", _start)

    started = _maybe_autostart_local_ollama(
        config=cfg,
        engine_key=None,
        console=_DummyConsole(),
    )

    assert started is True
    assert calls["start"] == 1


def test_skip_autostart_for_remote_ollama_host(monkeypatch) -> None:
    cfg = JarvisConfig()
    cfg.engine.default = "ollama"
    cfg.engine.ollama.host = "http://192.168.1.10:11434"

    calls = {"start": 0}

    def _start(_host: str) -> bool:
        calls["start"] += 1
        return True

    monkeypatch.setattr("openjarvis.cli.serve._start_ollama_process", _start)

    started = _maybe_autostart_local_ollama(
        config=cfg,
        engine_key=None,
        console=_DummyConsole(),
    )

    assert started is False
    assert calls["start"] == 0
