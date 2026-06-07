"""Pytest fixtures for production loader tests.

This conftest exposes ONLY factory fixtures (`agents_dir`,
`http_client_factory`).

A pre-built `parent_app` or HTTP client fixture would fix the parent
Starlette app at fixture-construction time, BEFORE the test seeds its temp
agents tree — every test would then see a parent app with zero agents
mounted. The correct order for every test is:

    root = agents_dir(("vendor", "slug"), ...)             # 1. seed temp tree
    app  = build_parent_app(root)                          # 2. build parent
    async with http_client_factory(app) as client: ...     # 3. construct client

Tests must follow this exact order.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

import pytest

# Ensure agent_loader is importable from /app (Docker image) and from the
# host-side checkout root (docker/wayflow/) without needing an installable
# package.
PARENT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PARENT))


# Reference OAS used as the seed body for fabricated agent dirs.
#
# Resolved lazily so this conftest can be imported during
# `pytest --collect-only` from any working directory — including the
# wayflow Docker image, which only mounts /app and may not include the
# repo `agents/` tree at parents[2].
#
# Resolution order:
#   1. CINATRA_SAMPLE_OAS env var (explicit path; used by Docker tests)
#   2. <repo-root>/agents/cinatra/email-recipient-selection-agent/cinatra/oas.json
#      (host-side checkout — parents[2] from this file)
#   3. Walk upward looking for the agents/ tree
_DEFAULT_SAMPLE_OAS_RELATIVE = (
    "agents/cinatra/email-recipient-selection-agent/cinatra/oas.json"
)


def _resolve_sample_oas_path() -> Path:
    """Return the path to the reference OAS, lazily."""
    env_path = os.environ.get("CINATRA_SAMPLE_OAS")
    if env_path:
        return Path(env_path)
    here = Path(__file__).resolve()
    # parents[2] = repo root when this file lives at <repo>/docker/wayflow/tests/
    if len(here.parents) >= 3:
        candidate = here.parents[2] / _DEFAULT_SAMPLE_OAS_RELATIVE
        if candidate.exists():
            return candidate
    # Last-ditch: walk upward (handles symlinked checkouts and unusual mounts).
    for parent in here.parents:
        candidate = parent / _DEFAULT_SAMPLE_OAS_RELATIVE
        if candidate.exists():
            return candidate
    return Path(_DEFAULT_SAMPLE_OAS_RELATIVE)


@pytest.fixture
def agents_dir(tmp_path: Path) -> Callable[..., Path]:
    """Factory fixture: returns a callable that seeds tmp_path with agent dirs.

    Each call to the factory creates `tmp_path/<vendor>/<slug>/cinatra/oas.json`
    for every (vendor, slug) pair, with metadata.cinatra.packageName patched
    to `@<vendor>/<slug>` so `extract_vendor_slug` recovers the pair.

    Returns the tmp_path root — pass it directly to `build_parent_app(root)`.

    The factory is intentionally NOT pre-evaluated. Each test invokes it
    AFTER it has decided what tree it wants, then builds the parent app
    from the populated root.
    """

    def _factory(*pairs: tuple[str, str], with_markers: bool = True) -> Path:
        sample_path = _resolve_sample_oas_path()
        if not sample_path.exists():
            raise RuntimeError(
                f"Reference OAS not found at {sample_path}. "
                "Test fixture cannot seed temp agent dirs. "
                "Set CINATRA_SAMPLE_OAS to override."
            )
        import hashlib
        sample = json.loads(sample_path.read_text(encoding="utf-8"))
        for vendor, slug in pairs:
            adir = tmp_path / vendor / slug / "cinatra"
            adir.mkdir(parents=True, exist_ok=True)
            # Deep-copy via JSON round-trip so per-agent edits don't bleed.
            body = json.loads(json.dumps(sample))
            body.setdefault("metadata", {}).setdefault("cinatra", {})[
                "packageName"
            ] = f"@{vendor}/{slug}"
            oas_text = json.dumps(body, indent=2)
            (adir / "oas.json").write_text(oas_text, encoding="utf-8")
            # Seed the published marker by default so tests treat fixtures as
            # "published". Tests that need an unmarked dir pass
            # with_markers=False.
            if with_markers:
                slug_dir = tmp_path / vendor / slug
                marker = {
                    "packageName": f"@{vendor}/{slug}",
                    "packageVersion": "1.0.0",
                    "oasSha256": hashlib.sha256(
                        oas_text.encode("utf-8")
                    ).hexdigest(),
                    "publishedAt": "2026-05-13T00:00:00+00:00",
                }
                (slug_dir / ".cinatra-published.json").write_text(
                    json.dumps(marker, indent=2) + "\n", encoding="utf-8"
                )
        return tmp_path

    return _factory


@pytest.fixture
def http_client_factory() -> Callable[[Any], Any]:
    """Factory fixture: returns a callable that builds an httpx ASGI client.

    Wraps the parent app in `asgi_lifespan.LifespanManager` so the parent
    lifespan dispatches to all mounted child A2AApps.
    The returned object is an async context manager — use `async with`.
    """
    import httpx
    from asgi_lifespan import LifespanManager

    class _AsyncASGIClient:
        def __init__(self, app: Any) -> None:
            self._app = app
            self._lifespan: Any = None
            self._client: Any = None

        async def __aenter__(self) -> Any:
            self._lifespan = LifespanManager(self._app)
            await self._lifespan.__aenter__()
            self._client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self._app),
                base_url="http://test",
            )
            await self._client.__aenter__()
            return self._client

        async def __aexit__(self, *args: Any) -> None:
            try:
                if self._client is not None:
                    await self._client.__aexit__(*args)
            finally:
                if self._lifespan is not None:
                    await self._lifespan.__aexit__(*args)

    def _make(app: Any) -> _AsyncASGIClient:
        return _AsyncASGIClient(app)

    return _make
