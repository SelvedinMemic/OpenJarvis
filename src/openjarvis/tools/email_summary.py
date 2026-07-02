"""Email summary tool — collect recent mail and summarize it in German."""

from __future__ import annotations

from typing import Any, List, Optional

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import Message, Role, ToolResult
from openjarvis.engine._stubs import InferenceEngine
from openjarvis.tools._stubs import BaseTool, ToolSpec


@ToolRegistry.register("email_summary")
class EmailSummaryTool(BaseTool):
    """Collect recent email and summarize it for the user."""

    tool_id = "email_summary"
    is_local = True

    def __init__(self, engine: Optional[InferenceEngine] = None, *, model: str = "") -> None:
        self._engine = engine
        self._model = model

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="email_summary",
            description=(
                "Collect recent email from connected mail sources and return a "
                "short German summary focused on urgent items, replies, and "
                "meetings."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "sources": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Email sources to include, e.g. ['gmail', 'outlook'].",
                    },
                    "hours_back": {
                        "type": "number",
                        "description": "How many hours back to collect mail from.",
                        "default": 24,
                    },
                    "max_items": {
                        "type": "integer",
                        "description": "Max items per source to include in the summary.",
                        "default": 30,
                    },
                    "unacted_only": {
                        "type": "boolean",
                        "description": "Prefer unread or otherwise unacted-on items.",
                        "default": False,
                    },
                },
                "required": ["sources"],
            },
            category="communication",
            timeout_seconds=120.0,
        )

    def execute(self, **params: Any) -> ToolResult:
        from openjarvis.tools.digest_collect import DigestCollectTool

        sources: List[str] = params.get("sources", [])
        hours_back = float(params.get("hours_back", 24))
        max_items = int(params.get("max_items", 30))
        unacted_only = bool(params.get("unacted_only", False))

        if not sources:
            sources = ["gmail", "gmail_imap", "outlook"]

        digest_tool = DigestCollectTool()
        digest_result = digest_tool.execute(
            sources=sources,
            hours_back=hours_back,
            unacted_only=unacted_only,
        )

        if not digest_result.success:
            return ToolResult(
                tool_name="email_summary",
                content=digest_result.content,
                success=False,
                metadata=digest_result.metadata,
            )

        if self._engine is None or not self._model:
            return ToolResult(
                tool_name="email_summary",
                content=digest_result.content,
                success=True,
                metadata={
                    **digest_result.metadata,
                    "mode": "raw_digest",
                },
            )

        system_prompt = (
            "Du fasst E-Mails auf Deutsch zusammen. Antworte nur auf Deutsch. "
            "Nenne zuerst die wichtigsten dringenden Punkte, dann Termine, dann "
            "Antworten, die notwendig sind. Maximal 5 Stichpunkte, kurz und klar."
        )
        user_prompt = (
            f"Fasse die folgenden E-Mails fuer mich zusammen.\n\n"
            f"{digest_result.content}\n\n"
            f"Konzentriere dich auf Antworten, Fristen, Termine und wichtige Risiken."
        )

        try:
            result = self._engine.generate(
                [
                    Message(role=Role.SYSTEM, content=system_prompt),
                    Message(role=Role.USER, content=user_prompt),
                ],
                model=self._model,
            )
            summary = result.get("content", "").strip()
            return ToolResult(
                tool_name="email_summary",
                content=summary or digest_result.content,
                success=True,
                usage=result.get("usage", {}),
                metadata={
                    **digest_result.metadata,
                    "sources": sources,
                    "hours_back": hours_back,
                    "max_items": max_items,
                    "model": self._model,
                },
            )
        except Exception as exc:
            return ToolResult(
                tool_name="email_summary",
                content=f"Email summary error: {exc}",
                success=False,
                metadata=digest_result.metadata,
            )
