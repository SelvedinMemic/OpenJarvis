"""Regression test for SWE-bench ``run_id`` collisions across concurrent cells.

Failure mode (observed 2026-05-18, twice):
    Multiple hybrid SWE cells running concurrently against the Modal
    ``swebench-harness`` shared its per-instance cache via a ``run_id``
    keyed only on ``instance_id``. Two cells scoring the same task hit
    "1 instances already run, skipping..." on the second call; the
    runner saw ``reason: no_report`` and scored that row 0 even when
    the patch was correct. First seen with
    ``minions-qwen27b-opus47-swe-n100`` vs the advisors cell; recurred
    on 2026-05-18 across three of four ``qwen36`` SWE cells.

Fix: ``_build_run_id(instance_id, cell_name)`` namespaces the run_id by
cell so concurrent cells can't collide while same-cell resumes still
hit the harness cache.

This test pins the contract:

1. Different cells + same instance → different run_ids (the bug).
2. Same cell + same instance → identical run_id (resume still works).
3. Both forms are filesystem-safe (no chars that would break the
   ``logs/run_evaluation/<run_id>/...`` subtree or the
   ``<model>.<run_id>.json`` summary glob).
4. Cell name flows from :class:`SWEBenchHarnessScorer` into the run_id —
   wiring regression guard, in case someone refactors and drops the
   ``cell_name`` kwarg.
"""

from __future__ import annotations

import re

import pytest

from openjarvis.evals.scorers.swebench_harness import (
    SWEBenchHarnessScorer,
    _build_run_id,
    _sanitize_run_id_part,
)


# Filenames + harness log paths must match this. Slashes, spaces, colons,
# and other shell-hostile chars would silently corrupt scoring.
_SAFE_RE = re.compile(r"^[A-Za-z0-9._-]+$")


INSTANCE = "astropy__astropy-12907"
CELL_A = "advisors-qwen36-opus47-swe-n100"
CELL_B = "skillorchestra-qwen36-opus47-swe-n100"


def test_different_cells_produce_different_run_ids():
    """The core bug: two cells, same instance → must not collide."""
    a = _build_run_id(INSTANCE, CELL_A)
    b = _build_run_id(INSTANCE, CELL_B)
    assert a != b, (
        f"run_id collision between cells {CELL_A!r} and {CELL_B!r} "
        f"on instance {INSTANCE!r}: both produced {a!r}"
    )
    # Both must still contain the instance id so the harness logs are
    # greppable by instance.
    assert INSTANCE in a
    assert INSTANCE in b


def test_same_cell_same_instance_is_stable():
    """Resume semantics: re-running the same cell must hit the cache."""
    assert _build_run_id(INSTANCE, CELL_A) == _build_run_id(INSTANCE, CELL_A)


def test_legacy_no_cell_name_preserves_old_format():
    """Single-cell callers (no ``cell_name``) keep the legacy ``oj-<id>``."""
    assert _build_run_id(INSTANCE, None) == f"oj-{INSTANCE}"
    assert _build_run_id(INSTANCE, "") == f"oj-{INSTANCE}"


@pytest.mark.parametrize(
    "cell_name",
    [
        CELL_A,
        CELL_B,
        "minions-qwen27b-opus47-swe-n100",
        # Hostile inputs — must still produce something path-safe.
        "weird/cell name with spaces",
        "cell:with:colons",
        "---leading-and-trailing---",
    ],
)
def test_run_id_is_filesystem_safe(cell_name: str):
    """Whatever we feed in, the run_id must be a clean path component."""
    rid = _build_run_id(INSTANCE, cell_name)
    assert _SAFE_RE.match(rid), f"run_id {rid!r} contains unsafe chars"


def test_sanitizer_strips_unsafe_chars():
    assert _sanitize_run_id_part("a/b c:d") == "a-b-c-d"
    assert _sanitize_run_id_part("---x---") == "x"
    assert _sanitize_run_id_part("ok-cell.1_2") == "ok-cell.1_2"


def test_scorer_threads_cell_name_into_run_id(monkeypatch):
    """End-to-end wiring: scorer constructor → ``_run_harness`` → run_id.

    Guards against a refactor that quietly drops the ``cell_name`` kwarg
    on the scorer or stops forwarding it to ``_run_harness``.
    """
    from openjarvis.evals.core.types import EvalRecord
    from openjarvis.evals.scorers import swebench_harness as mod

    captured: dict = {}

    def fake_run_harness(instance_id, patch, timeout_s, cell_name=None):
        captured["instance_id"] = instance_id
        captured["cell_name"] = cell_name
        captured["run_id"] = mod._build_run_id(instance_id, cell_name)
        return {"success": True, "score": 1.0, "details": {}}

    monkeypatch.setattr(mod, "_run_harness", fake_run_harness)

    scorer = SWEBenchHarnessScorer(timeout_s=60, cell_name=CELL_A)
    record = EvalRecord(
        record_id=INSTANCE,
        problem="",
        reference="",
        category="agentic",
        metadata={"instance_id": INSTANCE},
    )
    # Minimal patch text that ``extract_patch`` will accept.
    answer = "```diff\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n```"
    scorer.score(record, answer)

    assert captured["cell_name"] == CELL_A
    assert captured["instance_id"] == INSTANCE
    assert CELL_A in captured["run_id"]
    assert INSTANCE in captured["run_id"]

    # And the other cell name produces a *different* run_id end-to-end.
    captured.clear()
    scorer_b = SWEBenchHarnessScorer(timeout_s=60, cell_name=CELL_B)
    scorer_b.score(record, answer)
    assert captured["cell_name"] == CELL_B
    assert CELL_B in captured["run_id"]
    assert CELL_A not in captured["run_id"]
