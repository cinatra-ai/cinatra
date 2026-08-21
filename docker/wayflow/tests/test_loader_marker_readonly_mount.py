"""Fresh-install shape: a READ-ONLY agent source mount still serves agents.

cinatra#2873 ("D7"). The agent sources are mounted `:ro`
(`./extensions:/agents:ro`) on purpose — the runtime must never mutate an
operator's agent checkouts, and `cinatra-cli`'s dev repo sync deletes a
`.cinatra-published.json` it finds inside one as tool-generated debris.

But the loader gates every mount on that marker and a fresh install ships
none, so the marker backfill had nowhere to write: every write failed on the
`ro` mount, every agent was skipped, and the install served ZERO agents
(measured: 29 sources → 29 backfill failures → `agents: 0`, HTTP 404 on every
agent route).

These tests pin the contract that fixes it:

  * the derived marker goes to a WRITABLE dir the loader owns, never into the
    source tree;
  * a marker that IS in the source tree always wins, so the draft/published
    separation (a post-publish source edit gates the agent) is untouched;
  * a mid-draft dir (`.cinatra-in-progress.json`) is never derived;
  * the derived marker tracks the source bytes, so updating the sources under
    a read-only mount does not re-gate everything;
  * reload discovery — not just boot — serves on this state.

Hermetic: no wayflowcore, no docker, no repo `agents/` tree. Everything below
is fs fixtures + the loader's own discovery functions.

Run: cd docker/wayflow && python -m pytest tests/test_loader_marker_readonly_mount.py
"""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from agent_loader import (
    _IN_PROGRESS_MARKER_FILENAME,
    _PUBLISHED_MARKER_FILENAME,
    _backfill_missing_markers,
    _discover_agents_for_reload_inner,
    _inspect_published_marker,
    _sidecar_marker_dir,
    discover_agents,
    resolve_marker_state_root,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _oas_body(vendor: str, slug: str) -> Dict[str, Any]:
    """Minimal OAS carrying what discovery reads: the packageName."""
    return {
        "openapi": "3.1.0",
        "info": {"title": f"{slug} agent", "version": "1.0.0"},
        "metadata": {
            "cinatra": {
                "packageName": f"@{vendor}/{slug}",
                "packageVersion": "1.2.3",
            }
        },
        "paths": {},
    }


def _raw_write(path: Path, text: str) -> None:
    """Write via the builtin, NOT `Path.write_text`.

    The read-only simulation below patches `Path.write_text`; the fixtures
    themselves must keep writing through it, or seeding the tree would fail
    for the same reason the loader does.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def seed_agent(root: Path, vendor: str, slug: str) -> Path:
    """Seed `root/<vendor>/<slug>/cinatra/oas.json` with NO marker of any kind.

    That is the fresh-install shape: the agent source repos do not commit
    `.cinatra-published.json`.
    """
    oas_path = root / vendor / slug / "cinatra" / "oas.json"
    _raw_write(oas_path, json.dumps(_oas_body(vendor, slug), indent=2) + "\n")
    return oas_path


def labels(found: List[Tuple[str, str, Path, str]]) -> List[str]:
    return sorted(f"{vendor}/{slug}" for vendor, slug, _path, _sha in found)


def state_marker(state_root: Path, vendor: str, slug: str) -> Path:
    return state_root / vendor / slug / _PUBLISHED_MARKER_FILENAME


def source_markers_under(root: Path) -> List[Path]:
    return sorted(root.rglob(_PUBLISHED_MARKER_FILENAME))


@pytest.fixture
def readonly_source(monkeypatch: pytest.MonkeyPatch):
    """Make every `Path.write_text` under a given root fail with EROFS.

    A `chmod` fixture would be a no-op for a root-owned test runner (root
    writes through mode bits), and the container test runner IS root — so the
    read-only mount is simulated at the syscall the loader actually uses. The
    real-permissions variant runs as a separate, non-root-only test below.
    """

    def _install(root: Path) -> None:
        real_write_text = Path.write_text
        resolved_root = root.resolve()

        def guarded(self: Path, data: str, *args: Any, **kwargs: Any) -> int:
            try:
                self.resolve().relative_to(resolved_root)
            except (OSError, ValueError):
                return real_write_text(self, data, *args, **kwargs)
            raise OSError(errno.EROFS, "Read-only file system", str(self))

        monkeypatch.setattr(Path, "write_text", guarded)

    return _install


@pytest.fixture
def state_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the loader's state dir at a writable tmp dir (hermetic)."""
    root = tmp_path / "state"
    monkeypatch.setenv("CINATRA_AGENT_STATE_DIR", str(root))
    return root


# ---------------------------------------------------------------------------
# The D7 acceptance, at loader level.
# ---------------------------------------------------------------------------


def test_fresh_install_on_readonly_mount_serves_every_agent(
    tmp_path: Path,
    state_root: Path,
    readonly_source,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Zero markers + read-only source dir → every agent still loads.

    This is the issue's acceptance criterion reduced to the loader: sources
    present, nothing else done, no manual marker or mount surgery.
    """
    source = tmp_path / "extensions"
    for slug in ("blog-draft-writer-agent", "email-recipient-selection-agent"):
        seed_agent(source, "cinatra", slug)
    readonly_source(source)

    written = _backfill_missing_markers(source)
    assert written == 2, "both markerless agents should get a derived marker"

    # The source tree stays pristine — that is the security posture.
    assert source_markers_under(source) == []

    found = discover_agents(source)
    assert labels(found) == [
        "cinatra/blog-draft-writer-agent",
        "cinatra/email-recipient-selection-agent",
    ]

    # ...and the derived markers are the ones doing it.
    for slug in ("blog-draft-writer-agent", "email-recipient-selection-agent"):
        marker_path = state_marker(state_root, "cinatra", slug)
        assert marker_path.exists()
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        assert marker["packageName"] == f"@cinatra/{slug}"
        assert marker["packageVersion"] == "1.2.3"
        assert len(marker["oasSha256"]) == 64

    out = capsys.readouterr().out
    assert "failed to write" not in out, out
    assert "stays gated" not in out, out


def test_gate_reports_the_derived_marker_as_state_dir_sourced(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """The gate says WHERE a valid marker came from, so a mount that only
    works because of the fallback is legible in the report."""
    source = tmp_path / "extensions"
    oas_path = seed_agent(source, "cinatra", "blog-draft-writer-agent")
    readonly_source(source)
    _backfill_missing_markers(source)

    slug_dir = source / "cinatra" / "blog-draft-writer-agent"
    outcome = _inspect_published_marker(
        slug_dir,
        oas_path,
        sidecar_dir=_sidecar_marker_dir(state_root, source, slug_dir),
    )
    assert outcome["status"] == "valid"
    assert outcome["marker_source"] == "state-dir"


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root writes through mode bits; EROFS variant covers this runner",
)
def test_real_readonly_permissions_still_serve(
    tmp_path: Path, state_root: Path
) -> None:
    """Same acceptance against REAL permissions, not a patched write_text."""
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "blog-draft-writer-agent")
    slug_dir = source / "cinatra" / "blog-draft-writer-agent"
    slug_dir.chmod(0o555)
    try:
        # Guard the premise: if this runner can still write, the test proves
        # nothing — fail loudly rather than pass vacuously.
        probe = slug_dir / ".write-probe"
        writable = True
        try:
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write("")
        except OSError:
            writable = False
        else:
            probe.unlink()
        assert not writable, "chmod 0555 did not take — premise broken"

        assert _backfill_missing_markers(source) == 1
        assert source_markers_under(source) == []
        assert labels(discover_agents(source)) == [
            "cinatra/blog-draft-writer-agent"
        ]
    finally:
        slug_dir.chmod(0o755)


# ---------------------------------------------------------------------------
# The derived marker must not weaken the draft/published contract.
# ---------------------------------------------------------------------------


def test_source_marker_always_wins_over_a_derived_one(
    tmp_path: Path, state_root: Path
) -> None:
    """A STALE marker inside the agent dir keeps gating the agent even when a
    derived marker for the current bytes exists.

    That is the draft/published separation: `agent_source_write` edits
    `oas.json` without touching the published marker, and the hash mismatch is
    what stops the loader from mounting a draft. A derived marker must never
    be able to un-gate it.
    """
    source = tmp_path / "extensions"
    oas_path = seed_agent(source, "cinatra", "drafting")
    slug_dir = source / "cinatra" / "drafting"
    _raw_write(
        slug_dir / _PUBLISHED_MARKER_FILENAME,
        json.dumps(
            {
                "packageName": "@cinatra/drafting",
                "packageVersion": "1.0.0",
                "oasSha256": "0" * 64,  # stale on purpose
                "publishedAt": "2026-05-13T00:00:00+00:00",
            }
        ),
    )
    # Hand-plant a derived marker that DOES match the current bytes.
    import hashlib

    _raw_write(
        state_marker(state_root, "cinatra", "drafting"),
        json.dumps(
            {
                "packageName": "@cinatra/drafting",
                "packageVersion": "1.0.0",
                "oasSha256": hashlib.sha256(
                    oas_path.read_bytes()
                ).hexdigest(),
                "publishedAt": "2026-05-13T00:00:00+00:00",
            }
        ),
    )

    outcome = _inspect_published_marker(
        slug_dir,
        oas_path,
        sidecar_dir=_sidecar_marker_dir(state_root, source, slug_dir),
    )
    assert outcome["status"] == "hash_mismatch"
    assert discover_agents(source) == []


def test_backfill_leaves_a_stale_source_marker_alone(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """Backfill derives nothing for a dir that already carries a marker —
    stale or not. Repairing a source marker stays the host-side TS
    backfill's job (it owns the tree it can write)."""
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "stale")
    _raw_write(
        source / "cinatra" / "stale" / _PUBLISHED_MARKER_FILENAME,
        json.dumps(
            {
                "packageName": "@cinatra/stale",
                "packageVersion": "1.0.0",
                "oasSha256": "0" * 64,
                "publishedAt": "2026-05-13T00:00:00+00:00",
            }
        ),
    )
    readonly_source(source)

    assert _backfill_missing_markers(source) == 0
    assert not state_marker(state_root, "cinatra", "stale").exists()
    assert discover_agents(source) == []


def test_in_progress_draft_is_never_derived(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """A mid-draft dir stays unpublished.

    Deriving a marker for it would promote a draft that never went through
    `agent_source_publish` — the same guard the TS backfill carries.
    """
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "mid-draft")
    seed_agent(source, "cinatra", "ready")
    _raw_write(
        source / "cinatra" / "mid-draft" / _IN_PROGRESS_MARKER_FILENAME,
        json.dumps({"startedAt": "2026-08-20T00:00:00+00:00"}),
    )
    readonly_source(source)

    assert _backfill_missing_markers(source) == 1
    assert not state_marker(state_root, "cinatra", "mid-draft").exists()
    assert labels(discover_agents(source)) == ["cinatra/ready"]


# ---------------------------------------------------------------------------
# Durability: the derived marker tracks the source bytes.
# ---------------------------------------------------------------------------


def test_derived_marker_re_derives_when_the_source_oas_changes(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """Updating the sources under a read-only mount keeps them served.

    The derived marker is state the LOADER owns, not a publish record — if it
    kept pointing at the previous bytes, the next `git pull` of the agent
    sources would put the install straight back to zero agents.
    """
    source = tmp_path / "extensions"
    oas_path = seed_agent(source, "cinatra", "updating")
    readonly_source(source)
    assert _backfill_missing_markers(source) == 1
    first = labels(discover_agents(source))
    assert first == ["cinatra/updating"]

    # The operator updates the sources (host-side write; the mount is only
    # read-only from inside the container).
    body = _oas_body("cinatra", "updating")
    body["info"]["version"] = "2.0.0"
    _raw_write(oas_path, json.dumps(body, indent=2) + "\n")

    # Until the loader re-derives, the agent is gated on the old hash.
    assert discover_agents(source) == []

    assert _backfill_missing_markers(source) == 1
    assert labels(discover_agents(source)) == ["cinatra/updating"]


def test_backfill_is_idempotent_on_a_readonly_mount(
    tmp_path: Path,
    state_root: Path,
    readonly_source,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A second boot over an unchanged tree writes nothing and says nothing."""
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "steady")
    readonly_source(source)
    assert _backfill_missing_markers(source) == 1
    marker_path = state_marker(state_root, "cinatra", "steady")
    before = marker_path.read_text(encoding="utf-8")
    capsys.readouterr()

    assert _backfill_missing_markers(source) == 0
    assert marker_path.read_text(encoding="utf-8") == before
    assert capsys.readouterr().out == ""
    assert labels(discover_agents(source)) == ["cinatra/steady"]


# ---------------------------------------------------------------------------
# Reload — not just boot — has to work on this state.
# ---------------------------------------------------------------------------


def test_reload_discovery_serves_a_markerless_tree_after_backfill(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """Reload rediscovery gated every agent on a markerless tree, which is why
    the CLI's reload repair changed nothing on a fresh install. With the
    markers derived first, reload discovery mounts them."""
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "blog-draft-writer-agent")
    readonly_source(source)

    valid, parse_failed = _discover_agents_for_reload_inner(
        source, frozenset()
    )
    assert labels(valid) == []
    assert parse_failed == []

    _backfill_missing_markers(source)
    valid, parse_failed = _discover_agents_for_reload_inner(
        source, frozenset()
    )
    assert labels(valid) == ["cinatra/blog-draft-writer-agent"]
    assert parse_failed == []


# ---------------------------------------------------------------------------
# State-root resolution.
# ---------------------------------------------------------------------------


def test_state_root_falls_back_when_the_configured_dir_is_unusable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, readonly_source
) -> None:
    """A misconfigured state dir degrades to a writable fallback rather than
    taking the install back to zero agents."""
    blocker = tmp_path / "not-a-dir"
    _raw_write(blocker, "")
    monkeypatch.setenv("CINATRA_AGENT_STATE_DIR", str(blocker / "state"))

    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "fallback")
    readonly_source(source)

    resolved = resolve_marker_state_root(source, create=True)
    assert resolved is not None
    assert not str(resolved).startswith(str(blocker))

    assert _backfill_missing_markers(source) == 1
    assert labels(discover_agents(source)) == ["cinatra/fallback"]
    # Discovery must land on the SAME root the backfill wrote to.
    assert resolve_marker_state_root(source, create=False) == resolved


def test_disabling_the_state_dir_restores_the_pre_fix_gating(
    tmp_path: Path, state_root: Path, readonly_source
) -> None:
    """Passing `marker_state_root=None` opts out of the fallback entirely —
    the shape the issue measured: a read-only mount, no writable location, no
    agents. Pinned so the fallback cannot be removed silently."""
    source = tmp_path / "extensions"
    seed_agent(source, "cinatra", "gated")
    readonly_source(source)

    assert _backfill_missing_markers(source, marker_state_root=None) == 0
    assert discover_agents(source, marker_state_root=None) == []
