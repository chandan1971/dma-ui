"""LLM provider abstraction for the AI intelligence layer.

One interface (AIProvider) with interchangeable implementations — Mock,
Claude, OpenAI, Local (any OpenAI-compatible endpoint) and Gemini — chosen by
AI_PROVIDER at startup. Everything above this module (app/ai_service.py, the
API routes, the UI) is provider-agnostic: responses are plain text plus a
`live` capability flag, and nothing downstream may branch on WHICH provider
produced an answer.

Contracts every provider honors:
  * generate(system, messages) -> str        (complete answer)
  * stream(system, messages) -> async iter   (text deltas; providers without
    real streaming yield the complete answer once — callers can't tell)
  * failures raise AIProviderError with a SANITIZED, browser-safe message
    (never raw upstream envelopes, request ids, or key material)
  * providers only ever receive the sanitized payloads built by
    app/ai_context.py — this module never touches exchange credentials, and
    the AI layer as a whole has no path to a trade write.

The Claude implementation uses the official `anthropic` SDK (imported lazily
so every other provider — including the default mock — works without the
package). HTTP providers share ONE httpx.AsyncClient (pooling), closed via
aclose() from the app lifespan like dma_client/market_data.
"""
import json
import logging
from typing import AsyncIterator

import httpx

from .config import settings

logger = logging.getLogger("dma-ui.ai")

# Provider-default models (used when AI_MODEL is unset).
CLAUDE_DEFAULT_MODEL = "claude-opus-5"
OPENAI_DEFAULT_MODEL = "gpt-4o"
GEMINI_DEFAULT_MODEL = "gemini-3.6-flash"

PROVIDER_NAMES = ("mock", "claude", "openai", "local", "gemini")


class AIProviderError(Exception):
    """Sanitized provider failure. `retryable` hints 429/5xx-style transience."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class AIProvider:
    """Base interface. `name` is for server logs only — API responses carry
    capabilities (`live`, `streaming`), never the provider identity."""

    name = "base"
    live = True        # False => deterministic rule-based analysis (mock)
    streaming = False  # True => stream() yields real incremental deltas

    async def generate(self, system: str, messages: list[dict]) -> str:
        raise NotImplementedError

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        # Default: no true streaming — yield the whole answer once. Callers
        # iterate the same way either way, so the UI can never tell.
        yield await self.generate(system, messages)


# --------------------------------------------------------------------------
# Mock provider — the default. Deterministic and network-free: it renders an
# honest rule-based readout from the evidence pack embedded in the prompt
# (ai_service always includes a ```json fenced evidence block). This keeps the
# whole AI surface functional (and testable) with no key configured, clearly
# labelled in the UI via live=False — it must never masquerade as an LLM.
# --------------------------------------------------------------------------
def _extract_evidence_json(text: str) -> dict | None:
    # The SERVER's evidence block is always the LAST fence in the prompt
    # (ai_service appends it after the user's question), so take rfind — a
    # question that carries its own ```json block must never spoof the
    # "honest rule-based readout" with attacker-chosen numbers.
    start = text.rfind("```json")
    if start < 0:
        return None
    end = text.find("```", start + 7)
    if end < 0:
        return None
    try:
        data = json.loads(text[start + 7:end])
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


class MockProvider(AIProvider):
    name = "mock"
    live = False
    streaming = False

    async def generate(self, system: str, messages: list[dict]) -> str:
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        evidence = _extract_evidence_json(prompt)
        lines = [
            "**Rule-based analysis** (no AI provider configured — set AI_PROVIDER "
            "to enable narrative coaching; every number below is computed, not generated).",
            "",
        ]
        if evidence:
            stats = evidence.get("stats") or {}
            if stats:
                parts = []
                if "trades" in stats:
                    parts.append(f"{stats['trades']} trades")
                if "winRatePct" in stats:
                    parts.append(f"{stats['winRatePct']}% win rate")
                if "netPnl" in stats:
                    parts.append(f"net PnL {stats['netPnl']}")
                if "profitFactor" in stats:
                    parts.append(f"profit factor {stats['profitFactor']}")
                if parts:
                    lines.append("- Period: " + ", ".join(str(p) for p in parts))
            for finding in (evidence.get("findings") or [])[:8]:
                if isinstance(finding, dict) and finding.get("title"):
                    detail = finding.get("detail") or ""
                    lines.append(f"- **{finding['title']}** — {detail}".rstrip(" —"))
            if len(lines) <= 2:
                lines.append("- No notable patterns in the supplied evidence.")
        else:
            lines.append("- No evidence pack found in the request; nothing to analyze.")
        lines.append("")
        lines.append("Review the Patterns view for the full evidence behind each line.")
        return "\n".join(lines)


# --------------------------------------------------------------------------
# Claude (official `anthropic` SDK; lazy import so it is only required when
# AI_PROVIDER=claude).
# --------------------------------------------------------------------------
class ClaudeProvider(AIProvider):
    name = "claude"
    streaming = True

    def __init__(self):
        self.model = settings.AI_MODEL or CLAUDE_DEFAULT_MODEL
        self._client = None  # injectable in tests

    def _ensure_client(self):
        if self._client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover - env-dependent
                raise AIProviderError(
                    "the anthropic package is not installed on the server"
                ) from exc
            kwargs: dict = {"api_key": settings.AI_API_KEY, "timeout": settings.AI_TIMEOUT_S}
            if settings.AI_BASE_URL:
                kwargs["base_url"] = settings.AI_BASE_URL
            self._client = anthropic.AsyncAnthropic(**kwargs)
        return self._client

    @staticmethod
    def _text_of(message) -> str:
        # A safety-classifier decline is a NORMAL 200 with stop_reason
        # "refusal" — surface it honestly instead of returning empty text.
        if getattr(message, "stop_reason", None) == "refusal":
            raise AIProviderError("the model declined to analyze this request")
        return "".join(
            block.text for block in message.content if getattr(block, "type", "") == "text"
        )

    def _wrap_error(self, exc: Exception) -> AIProviderError:
        import anthropic
        if isinstance(exc, anthropic.RateLimitError):
            return AIProviderError("AI provider rate limit reached; try again shortly", retryable=True)
        if isinstance(exc, anthropic.AuthenticationError):
            return AIProviderError("AI provider rejected the configured API key")
        if isinstance(exc, anthropic.APIStatusError):
            retryable = exc.status_code >= 500
            return AIProviderError(f"AI provider error ({exc.status_code})", retryable=retryable)
        if isinstance(exc, anthropic.APIConnectionError):
            return AIProviderError("could not reach the AI provider", retryable=True)
        return AIProviderError("AI provider request failed")

    async def generate(self, system: str, messages: list[dict]) -> str:
        client = self._ensure_client()
        import anthropic
        try:
            # Server-side fallbacks: if the model's safety classifiers decline
            # (rare but possible on security-adjacent trading text), the API
            # re-runs the request on Anthropic's recommended fallback model in
            # the same call instead of failing the briefing.
            message = await client.beta.messages.create(
                model=self.model,
                max_tokens=settings.AI_MAX_TOKENS,
                system=system,
                messages=messages,
                betas=["server-side-fallback-2026-07-01"],
                # `fallbacks: "default"` via extra_body: the scalar form may
                # lag the SDK's typed params; extra_body forwards it verbatim.
                extra_body={"fallbacks": "default"},
            )
        except anthropic.BadRequestError:
            # The fallbacks beta is the only non-GA part of this request; if
            # the API ever rejects it, degrade to a plain call instead of
            # failing every briefing while streaming (no beta) keeps working.
            logger.warning("claude generate: beta request rejected — retrying without fallbacks")
            try:
                message = await client.messages.create(
                    model=self.model,
                    max_tokens=settings.AI_MAX_TOKENS,
                    system=system,
                    messages=messages,
                )
            except anthropic.APIError as exc:
                logger.warning("claude generate failed: %s", type(exc).__name__)
                raise self._wrap_error(exc)
        except anthropic.APIError as exc:
            logger.warning("claude generate failed: %s", type(exc).__name__)
            raise self._wrap_error(exc)
        return self._text_of(message)

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        client = self._ensure_client()
        import anthropic
        try:
            async with client.messages.stream(
                model=self.model,
                max_tokens=settings.AI_MAX_TOKENS,
                system=system,
                messages=messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
                if getattr(final, "stop_reason", None) == "refusal":
                    raise AIProviderError("the model declined to analyze this request")
        except anthropic.APIError as exc:
            logger.warning("claude stream failed: %s", type(exc).__name__)
            raise self._wrap_error(exc)


# --------------------------------------------------------------------------
# OpenAI-compatible chat completions over raw HTTP (shared httpx client).
# LocalProvider is the same wire format pointed at AI_BASE_URL (Ollama, vLLM,
# LM Studio, llama.cpp server, ...) — by design, so any self-hosted model that
# speaks the de-facto-standard API plugs in with zero code.
# --------------------------------------------------------------------------
_http_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=settings.AI_TIMEOUT_S)
    return _http_client


async def aclose() -> None:
    """Close the shared HTTP client — and the Claude SDK client, which owns
    its own pool — on shutdown (repo-wide lifespan convention)."""
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None
    if _provider is not None:
        sdk_client = getattr(_provider, "_client", None)
        close = getattr(sdk_client, "close", None)
        if callable(close):
            try:
                await close()
            except Exception:  # shutdown must never fail on cleanup
                pass


def _wrap_http_error(exc: Exception) -> AIProviderError:
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 401:
            return AIProviderError("AI provider rejected the configured API key")
        if code == 429:
            return AIProviderError("AI provider rate limit reached; try again shortly", retryable=True)
        return AIProviderError(f"AI provider error ({code})", retryable=code >= 500)
    if isinstance(exc, httpx.HTTPError):
        return AIProviderError("could not reach the AI provider", retryable=True)
    return AIProviderError("AI provider request failed")


class OpenAIProvider(AIProvider):
    name = "openai"
    streaming = True
    default_base = "https://api.openai.com"

    def __init__(self):
        self.model = settings.AI_MODEL or OPENAI_DEFAULT_MODEL
        self.base = settings.AI_BASE_URL or self.default_base

    def _payload(self, system: str, messages: list[dict], stream: bool) -> dict:
        return {
            "model": self.model,
            "max_tokens": settings.AI_MAX_TOKENS,
            "stream": stream,
            "messages": [{"role": "system", "content": system}, *messages],
        }

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {settings.AI_API_KEY}"} if settings.AI_API_KEY else {}

    async def generate(self, system: str, messages: list[dict]) -> str:
        try:
            resp = await _http().post(
                self.base + "/v1/chat/completions",
                json=self._payload(system, messages, stream=False),
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            logger.warning("%s generate failed: %s", self.name, type(exc).__name__)
            raise _wrap_http_error(exc)
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise AIProviderError("AI provider returned an unexpected response shape")

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        try:
            async with _http().stream(
                "POST",
                self.base + "/v1/chat/completions",
                json=self._payload(system, messages, stream=True),
                headers=self._headers(),
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if not chunk or chunk == "[DONE]":
                        continue
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"].get("content")
                    except (ValueError, KeyError, IndexError, TypeError):
                        continue  # keep-alives / role-only deltas
                    if delta:
                        yield delta
        except httpx.HTTPError as exc:
            logger.warning("%s stream failed: %s", self.name, type(exc).__name__)
            raise _wrap_http_error(exc)


class LocalProvider(OpenAIProvider):
    name = "local"

    def __init__(self):
        if not settings.AI_BASE_URL:
            raise AIProviderError("AI_PROVIDER=local requires AI_BASE_URL")
        super().__init__()
        self.model = settings.AI_MODEL or "local-model"


class GeminiProvider(AIProvider):
    name = "gemini"
    streaming = False  # non-streaming REST; stream() falls back to one chunk

    def __init__(self):
        self.model = settings.AI_MODEL or GEMINI_DEFAULT_MODEL
        self.base = settings.AI_BASE_URL or "https://generativelanguage.googleapis.com"

    async def generate(self, system: str, messages: list[dict]) -> str:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {
                    "role": "model" if m.get("role") == "assistant" else "user",
                    "parts": [{"text": str(m.get("content", ""))}],
                }
                for m in messages
            ],
            "generationConfig": {"maxOutputTokens": settings.AI_MAX_TOKENS},
        }
        try:
            resp = await _http().post(
                f"{self.base}/v1beta/models/{self.model}:generateContent",
                json=body,
                # Key goes in a header — never in the URL, where it could
                # end up in access logs.
                headers={"x-goog-api-key": settings.AI_API_KEY},
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            logger.warning("gemini generate failed: %s", type(exc).__name__)
            raise _wrap_http_error(exc)
        try:
            parts = data["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError, TypeError):
            raise AIProviderError("AI provider returned an unexpected response shape")


# --------------------------------------------------------------------------
# Factory — ONE provider per process, chosen from config at first use.
# --------------------------------------------------------------------------
_REGISTRY = {
    "mock": MockProvider,
    "claude": ClaudeProvider,
    "openai": OpenAIProvider,
    "local": LocalProvider,
    "gemini": GeminiProvider,
}

_provider: AIProvider | None = None


def get_provider() -> AIProvider:
    """The configured provider (lazy singleton). An unknown AI_PROVIDER value
    or a misconfigured live provider degrades LOUDLY to mock — the AI surface
    stays functional and the status endpoint reports live=false, but no config
    typo may silently spend money on the wrong provider."""
    global _provider
    if _provider is None:
        name = settings.AI_PROVIDER or "mock"
        cls = _REGISTRY.get(name)
        if cls is None:
            logger.warning("unknown AI_PROVIDER=%r — falling back to mock", name)
            cls = MockProvider
        elif name != "mock" and name != "local" and not settings.AI_API_KEY:
            logger.warning("AI_PROVIDER=%s has no AI_API_KEY — falling back to mock", name)
            cls = MockProvider
        try:
            _provider = cls()
        except AIProviderError as exc:
            logger.warning("AI provider %s unusable (%s) — falling back to mock", name, exc)
            _provider = MockProvider()
        logger.info("ai provider ready: %s (live=%s)", _provider.name, _provider.live)
    return _provider


def reset_provider() -> None:
    """Test seam: forget the singleton so config changes take effect."""
    global _provider
    _provider = None
