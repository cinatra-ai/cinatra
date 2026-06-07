"""Marker-gated discovery + backfill tests.

Coverage:
  Discovery-direct (no backfill): tests call `discover_agents(root)` against
  a hand-seeded fixture tree. Backfill is NOT invoked.

  Build-parent-app (with backfill): tests call `build_parent_app(root)` so
  the backfill walks the tree before discovery sees it. Used to assert
  backfill semantics + that backfill enables mounting.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_loader import (
    _PUBLISHED_MARKER_FILENAME,
    _inspect_published_marker,
    _read_published_marker,
    _backfill_missing_markers,
    discover_agents,
    build_parent_app,
)


def _resolve_sample_oas() -> Path:
    env_path = os.environ.get("CINATRA_SAMPLE_OAS")
    if env_path:
        return Path(env_path)
    here = Path(__file__).resolve()
    rel = "agents/cinatra/email-recipient-selection-agent/cinatra/oas.json"
    for parent in here.parents:
        candidate = parent / rel
        if candidate.exists():
            return candidate
    raise RuntimeError("sample OAS not found")


def _seed_agent(root: Path, vendor: str, slug: str) -> Path:
    """Seed `root/<vendor>/<slug>/cinatra/oas.json` (no marker).

    Returns the path to oas.json.
    """
    sample_path = _resolve_sample_oas()
    body = json.loads(sample_path.read_text(encoding="utf-8"))
    body.setdefault("metadata", {}).setdefault("cinatra", {})[
        "packageName"
    ] = f"@{vendor}/{slug}"
    target = root / vendor / slug / "cinatra"
    target.mkdir(parents=True, exist_ok=True)
    oas_path = target / "oas.json"
    oas_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return oas_path


def _write_marker(
    slug_dir: Path,
    *,
    package_name: str,
    package_version: str = "1.0.0",
    oas_sha: str | None = None,
    extra: dict | None = None,
) -> Path:
    """Write a `.cinatra-published.json` next to `cinatra/oas.json` under slug_dir.

    If `oas_sha` is None, computes the sha of the existing oas.json on disk.
    """
    import hashlib

    if oas_sha is None:
        oas_path = slug_dir / "cinatra" / "oas.json"
        oas_sha = hashlib.sha256(oas_path.read_bytes()).hexdigest()
    marker = {
        "packageName": package_name,
        "packageVersion": package_version,
        "oasSha256": oas_sha,
        "publishedAt": "2026-05-13T00:00:00+00:00",
    }
    if extra:
        marker.update(extra)
    marker_path = slug_dir / _PUBLISHED_MARKER_FILENAME
    marker_path.write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    return marker_path


# ---------------------------------------------------------------------------
# Discovery-direct (no backfill) — calls discover_agents() against a
# hand-seeded tree.
# ---------------------------------------------------------------------------


def test_unmarked_dir_skipped_by_discover_agents(tmp_path: Path) -> None:
    """An agent dir without `.cinatra-published.json` is treated as a draft
    and NOT returned by `discover_agents()`.

    This is the core publish-boundary guarantee: chat-builder drafts
    written via `agent_source_write` do not get auto-mounted on next boot
    just because the file lives at the canonical disk path.
    """
    _seed_agent(tmp_path, "cinatra", "draft-only")
    results = discover_agents(tmp_path)
    assert results == [], (
        f"unmarked dir should be skipped, got {results!r}"
    )


def test_marker_hash_match_is_mounted(tmp_path: Path) -> None:
    """A dir with a marker whose `oasSha256` matches the current
    `cinatra/oas.json` content IS returned by `discover_agents()`.

    Pins the happy path: publish writes both the OAS and a matching marker,
    discovery mounts the agent.
    """
    _seed_agent(tmp_path, "cinatra", "published")
    _write_marker(
        tmp_path / "cinatra" / "published",
        package_name="@cinatra/published",
    )
    results = discover_agents(tmp_path)
    assert len(results) == 1
    vendor, slug, oas_path, oas_sha256 = results[0]
    assert len(oas_sha256) == 64, "fingerprint should be 64-hex sha256"
    assert (vendor, slug) == ("cinatra", "published")
    assert oas_path.name == "oas.json"


def test_marker_hash_mismatch_skipped_at_startup(tmp_path: Path) -> None:
    """A dir with a marker whose `oasSha256` doesn't match the on-disk
    `cinatra/oas.json` is treated as a draft overwrite of an earlier
    published file and is NOT returned by `discover_agents()`.

    This is the auto-invalidation guarantee that makes
    `agent_source_write` safe — drafts on top of an existing published
    agent invalidate the marker without any explicit clear step.
    """
    _seed_agent(tmp_path, "cinatra", "drift")
    _write_marker(
        tmp_path / "cinatra" / "drift",
        package_name="@cinatra/drift",
        oas_sha="deadbeef" * 8,  # wrong hash
    )
    results = discover_agents(tmp_path)
    assert results == [], (
        f"marker with stale hash must be skipped, got {results!r}"
    )


def test_marker_malformed_skipped(tmp_path: Path) -> None:
    """A marker that fails JSON parse OR schema validation is treated as
    missing — `discover_agents` does NOT mount the agent.
    """
    _seed_agent(tmp_path, "cinatra", "malformed")
    marker_path = tmp_path / "cinatra" / "malformed" / _PUBLISHED_MARKER_FILENAME
    marker_path.write_text("{ this is not valid json", encoding="utf-8")
    results = discover_agents(tmp_path)
    assert results == [], (
        f"malformed marker must be skipped, got {results!r}"
    )


def test_marker_schema_missing_key_skipped(tmp_path: Path) -> None:
    """Marker missing a required key (e.g. `oasSha256`) is treated as
    malformed — `discover_agents` does NOT mount.
    """
    _seed_agent(tmp_path, "cinatra", "no-sha")
    marker_path = (
        tmp_path / "cinatra" / "no-sha" / _PUBLISHED_MARKER_FILENAME
    )
    marker_path.write_text(
        json.dumps(
            {
                "packageName": "@cinatra/no-sha",
                "packageVersion": "1.0.0",
                # oasSha256 + publishedAt missing
            }
        ),
        encoding="utf-8",
    )
    results = discover_agents(tmp_path)
    assert results == []


def test_inspect_marker_returns_hash_mismatch_status(tmp_path: Path) -> None:
    """`_inspect_published_marker` (used by reload) distinguishes the
    `hash_mismatch` outcome from `missing`/`malformed`. This is what lets
    reload emit `kind: "draft_overrides_published"` on an existing-mounted
    label.
    """
    _seed_agent(tmp_path, "cinatra", "drift")
    slug_dir = tmp_path / "cinatra" / "drift"
    _write_marker(
        slug_dir,
        package_name="@cinatra/drift",
        oas_sha="abcdef" * 10 + "abcd",
    )
    oas_path = slug_dir / "cinatra" / "oas.json"
    inspect = _inspect_published_marker(slug_dir, oas_path)
    assert inspect["status"] == "hash_mismatch", inspect
    assert "marker_sha" in inspect
    assert "actual_sha" in inspect
    assert inspect["marker_sha"] != inspect["actual_sha"]


def test_inspect_marker_handles_invalid_utf8_as_malformed(tmp_path: Path) -> None:
    """A marker file with invalid UTF-8 bytes (e.g. a corrupted half-write)
    MUST surface as malformed rather than letting `UnicodeDecodeError`
    escape `marker_path.read_text` and crash startup discovery / 500 the
    reload endpoint.
    """
    _seed_agent(tmp_path, "cinatra", "bad-utf8")
    slug_dir = tmp_path / "cinatra" / "bad-utf8"
    marker_path = slug_dir / _PUBLISHED_MARKER_FILENAME
    # Lone continuation byte 0x80 is invalid UTF-8 at byte 0.
    marker_path.write_bytes(b"\x80\xa0invalid utf-8 bytes")
    oas_path = slug_dir / "cinatra" / "oas.json"
    inspect = _inspect_published_marker(slug_dir, oas_path)
    assert inspect["status"] == "malformed", inspect
    assert "UnicodeDecodeError" in inspect["error"]


# ---------------------------------------------------------------------------
# TOCTOU pinning + distinct kind classification.
# ---------------------------------------------------------------------------


def test_inspect_marker_uses_precomputed_sha256_and_skips_oas_read(
    tmp_path: Path,
) -> None:
    """When `precomputed_oas_sha256` is provided, `_inspect_published_marker`
    MUST NOT re-read oas.json — the hash is bound to the bytes the caller
    has already validated. This closes the TOCTOU race where a host-side
    writer could flip the file between marker validation and mount.
    """
    import hashlib

    _seed_agent(tmp_path, "cinatra", "pinned")
    slug_dir = tmp_path / "cinatra" / "pinned"
    oas_path = slug_dir / "cinatra" / "oas.json"
    real_sha = hashlib.sha256(oas_path.read_bytes()).hexdigest()
    _write_marker(
        slug_dir,
        package_name="@cinatra/pinned",
        oas_sha=real_sha,
    )
    # Sanity — without precomputed hash, marker validates.
    assert (
        _inspect_published_marker(slug_dir, oas_path)["status"] == "valid"
    )
    # Now delete oas.json and replace with a stub that has a different hash —
    # this simulates a host-side flip BETWEEN discovery (when the caller
    # already hashed the bytes) and mount.
    oas_path.write_text("{ \"tampered\": true }\n", encoding="utf-8")
    # Without precomputed: marker re-reads and detects mismatch (proves
    # the test simulation is valid).
    inspect_reread = _inspect_published_marker(slug_dir, oas_path)
    assert inspect_reread["status"] == "hash_mismatch", inspect_reread
    # WITH precomputed (the bytes the caller already hashed): still valid,
    # because the marker is bound to that precomputed hash, NOT whatever
    # the file looks like now. This is the TOCTOU close.
    inspect_pinned = _inspect_published_marker(
        slug_dir, oas_path, precomputed_oas_sha256=real_sha
    )
    assert inspect_pinned["status"] == "valid", inspect_pinned


def test_discover_agents_returns_fingerprint(tmp_path: Path) -> None:
    """`discover_agents` returns 4-tuples that include the sha256 of the
    bytes used to validate the marker. The same hash is passed to
    `_mount_one_sync`, which re-verifies before mounting.
    """
    import hashlib

    _seed_agent(tmp_path, "cinatra", "withhash")
    slug_dir = tmp_path / "cinatra" / "withhash"
    oas_path = slug_dir / "cinatra" / "oas.json"
    expected_sha = hashlib.sha256(oas_path.read_bytes()).hexdigest()
    _write_marker(
        slug_dir,
        package_name="@cinatra/withhash",
        oas_sha=expected_sha,
    )
    results = discover_agents(tmp_path)
    assert len(results) == 1
    vendor, slug, oas_path_returned, oas_sha256 = results[0]
    assert vendor == "cinatra"
    assert slug == "withhash"
    assert oas_sha256 == expected_sha
    assert len(oas_sha256) == 64


def test_mount_one_sync_rejects_post_discovery_oas_tamper(tmp_path: Path) -> None:
    """Defense-in-depth: even if a host-side writer flips oas.json between
    `discover_agents` (validates marker against fingerprint F1) and
    `_mount_one_sync` (re-reads to load), the mount MUST refuse to load
    bytes whose hash != F1.
    """
    from agent_loader import _mount_one_sync

    _seed_agent(tmp_path, "cinatra", "tamper")
    slug_dir = tmp_path / "cinatra" / "tamper"
    oas_path = slug_dir / "cinatra" / "oas.json"
    # Use the original sha as the "expected" fingerprint.
    import hashlib

    original_sha = hashlib.sha256(oas_path.read_bytes()).hexdigest()
    # Simulate a host-side flip after the marker was validated.
    oas_path.write_text("{ \"flipped\": true }\n", encoding="utf-8")
    # _mount_one_sync should raise — never silently mount tampered bytes.
    with pytest.raises(ValueError) as exc_info:
        _mount_one_sync(
            loader=None,  # never reached
            vendor="cinatra",
            slug="tamper",
            oas_path=oas_path,
            fingerprint=original_sha,
            base_url="http://host.docker.internal:3000",
        )
    assert "changed between discovery and mount" in str(exc_info.value)


def test_reload_distinguishes_marker_failure_kinds(tmp_path: Path) -> None:
    """Reload's failed[] kind_hint MUST distinguish:
      - hash_mismatch → "draft_overrides_published" (a real draft)
      - missing      → "marker_missing"
      - malformed    → "marker_malformed"
      - io_error     → "marker_io_error"
    so operators can tell a benign draft override from real corruption.
    """
    from agent_loader import _discover_agents_for_reload_inner
    import hashlib

    # 4 separate dirs, each in a different failure state.
    # All 4 are "currently_mounted" so all 4 should surface in failed[].
    _seed_agent(tmp_path, "cinatra", "missing-marker")  # no marker file
    _seed_agent(tmp_path, "cinatra", "malformed-marker")
    _seed_agent(tmp_path, "cinatra", "mismatch-marker")
    _seed_agent(tmp_path, "cinatra", "valid-marker")

    # malformed: marker exists but is not valid JSON.
    (tmp_path / "cinatra" / "malformed-marker" / _PUBLISHED_MARKER_FILENAME).write_text(
        "{ this is not json",
        encoding="utf-8",
    )
    # mismatch: marker is valid JSON but oasSha256 doesn't match.
    _write_marker(
        tmp_path / "cinatra" / "mismatch-marker",
        package_name="@cinatra/mismatch-marker",
        oas_sha="0" * 64,
    )
    # valid: marker oasSha256 matches.
    _write_marker(
        tmp_path / "cinatra" / "valid-marker",
        package_name="@cinatra/valid-marker",
        oas_sha=hashlib.sha256(
            (tmp_path / "cinatra" / "valid-marker" / "cinatra" / "oas.json").read_bytes()
        ).hexdigest(),
    )

    currently = frozenset(
        {
            "cinatra/missing-marker",
            "cinatra/malformed-marker",
            "cinatra/mismatch-marker",
            "cinatra/valid-marker",
        }
    )
    valid, parse_failed = _discover_agents_for_reload_inner(
        tmp_path, currently_mounted=currently
    )
    kinds_by_label = {
        f"{v}/{s}": kind_hint for (v, s, _, _, kind_hint) in parse_failed
    }
    assert kinds_by_label.get("cinatra/missing-marker") == "marker_missing", parse_failed
    assert kinds_by_label.get("cinatra/malformed-marker") == "marker_malformed", parse_failed
    assert (
        kinds_by_label.get("cinatra/mismatch-marker") == "draft_overrides_published"
    ), parse_failed
    # The valid one should be in `valid`, not `parse_failed`.
    valid_labels = {f"{v}/{s}" for (v, s, _, _) in valid}
    assert "cinatra/valid-marker" in valid_labels


def test_reload_in_progress_draft_kind_overrides_other_statuses(
    tmp_path: Path,
) -> None:
    """When `.cinatra-in-progress.json` is present next to the slug dir,
    the reload report's `failed[].kind_hint` MUST surface as
    `marker_in_progress_draft`, regardless of whether the underlying
    marker-gate status was `missing`, `malformed`, or `hash_mismatch`.
    The signal communicates "this draft is intentional, not corruption"
    so operators don't get alarming kinds for in-edit chat-builder sessions.
    """
    from agent_loader import (
        _discover_agents_for_reload_inner,
        _IN_PROGRESS_MARKER_FILENAME,
    )

    # Three different underlying marker-gate states, all with the
    # in-progress marker present. All three should report
    # marker_in_progress_draft.
    _seed_agent(tmp_path, "cinatra", "in-progress-missing")
    _seed_agent(tmp_path, "cinatra", "in-progress-malformed")
    _seed_agent(tmp_path, "cinatra", "in-progress-mismatch")

    # in-progress-missing: no published marker at all.
    (tmp_path / "cinatra" / "in-progress-missing" / _IN_PROGRESS_MARKER_FILENAME).write_text(
        json.dumps({"packageSlug": "in-progress-missing", "lastEditAt": "2026-05-13T07:00:00Z"}),
        encoding="utf-8",
    )
    # in-progress-malformed: published marker is bad JSON.
    (tmp_path / "cinatra" / "in-progress-malformed" / _PUBLISHED_MARKER_FILENAME).write_text(
        "{ this is not json",
        encoding="utf-8",
    )
    (tmp_path / "cinatra" / "in-progress-malformed" / _IN_PROGRESS_MARKER_FILENAME).write_text(
        json.dumps({"packageSlug": "in-progress-malformed", "lastEditAt": "2026-05-13T07:00:00Z"}),
        encoding="utf-8",
    )
    # in-progress-mismatch: published marker has a stale hash.
    _write_marker(
        tmp_path / "cinatra" / "in-progress-mismatch",
        package_name="@cinatra/in-progress-mismatch",
        oas_sha="0" * 64,
    )
    (tmp_path / "cinatra" / "in-progress-mismatch" / _IN_PROGRESS_MARKER_FILENAME).write_text(
        json.dumps({"packageSlug": "in-progress-mismatch", "lastEditAt": "2026-05-13T07:00:00Z"}),
        encoding="utf-8",
    )
    # in-progress-io-error: published marker bytes are invalid UTF-8 (raises
    # UnicodeDecodeError) — _inspect_published_marker returns status=malformed.
    # Even though the underlying status differs, in-progress override applies.
    _seed_agent(tmp_path, "cinatra", "in-progress-io-malformed")
    (tmp_path / "cinatra" / "in-progress-io-malformed" / _PUBLISHED_MARKER_FILENAME).write_bytes(
        b"\x80\xa0invalid utf-8 bytes"
    )
    (tmp_path / "cinatra" / "in-progress-io-malformed" / _IN_PROGRESS_MARKER_FILENAME).write_text(
        json.dumps({"packageSlug": "in-progress-io-malformed", "lastEditAt": "2026-05-13T07:00:00Z"}),
        encoding="utf-8",
    )

    currently = frozenset(
        {
            "cinatra/in-progress-missing",
            "cinatra/in-progress-malformed",
            "cinatra/in-progress-mismatch",
            "cinatra/in-progress-io-malformed",
        }
    )
    valid, parse_failed = _discover_agents_for_reload_inner(
        tmp_path, currently_mounted=currently
    )
    kinds_by_label = {
        f"{v}/{s}": kind_hint for (v, s, _, _, kind_hint) in parse_failed
    }
    for slug in (
        "in-progress-missing",
        "in-progress-malformed",
        "in-progress-mismatch",
        "in-progress-io-malformed",
    ):
        assert (
            kinds_by_label.get(f"cinatra/{slug}") == "marker_in_progress_draft"
        ), f"{slug}: expected marker_in_progress_draft, got {kinds_by_label.get(f'cinatra/{slug}')!r}; parse_failed={parse_failed}"


def test_backfill_skips_oas_with_parse_failure(tmp_path: Path) -> None:
    """Python `_backfill_missing_markers` skips dirs where oas.json fails
    to parse — does NOT bless invalid JSON as "published". TS-side mirror
    in materialize-agent-package.ts.
    """
    # Seed a dir with malformed oas.json — no marker.
    target = tmp_path / "cinatra" / "garbage"
    (target / "cinatra").mkdir(parents=True)
    (target / "cinatra" / "oas.json").write_text(
        "{ this is not valid json",
        encoding="utf-8",
    )
    written = _backfill_missing_markers(tmp_path)
    assert written == 0, "backfill must NOT write a marker for invalid JSON"
    assert not (target / _PUBLISHED_MARKER_FILENAME).exists()


# ---------------------------------------------------------------------------
# Build-parent-app (with backfill) — backfill should produce markers for
# unmarked dirs.
# ---------------------------------------------------------------------------


def test_backfill_creates_marker_for_unmarked_dir(tmp_path: Path) -> None:
    """`_backfill_missing_markers` writes a marker for any agent dir that
    has a valid oas.json but no marker file.

    This is the migration path: on first deploy of the new wayflow image,
    every existing agent on disk gets a marker derived from its current
    oas.json hash (treated as "published" — backward compatible).
    """
    _seed_agent(tmp_path, "cinatra", "auto")
    marker_path = tmp_path / "cinatra" / "auto" / _PUBLISHED_MARKER_FILENAME
    assert not marker_path.exists()

    written = _backfill_missing_markers(tmp_path)
    assert written == 1
    assert marker_path.exists()

    body = json.loads(marker_path.read_text(encoding="utf-8"))
    assert body["packageName"] == "@cinatra/auto"
    assert isinstance(body["oasSha256"], str) and len(body["oasSha256"]) == 64
    assert "publishedAt" in body
    assert "packageVersion" in body


def test_backfill_preserves_existing_marker(tmp_path: Path) -> None:
    """Idempotency — `_backfill_missing_markers` does NOT overwrite a
    marker that already exists on disk, even if its hash is stale.
    """
    _seed_agent(tmp_path, "cinatra", "keep")
    slug_dir = tmp_path / "cinatra" / "keep"
    _write_marker(
        slug_dir,
        package_name="@cinatra/keep",
        package_version="9.9.9",
        oas_sha="staleeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    )
    marker_path = slug_dir / _PUBLISHED_MARKER_FILENAME
    before = marker_path.read_text(encoding="utf-8")

    written = _backfill_missing_markers(tmp_path)
    assert written == 0  # nothing new written

    after = marker_path.read_text(encoding="utf-8")
    assert before == after, "existing marker should be untouched"


def test_backfill_python_side_does_not_rewrite_stale_marker(
    tmp_path: Path,
) -> None:
    """Lock the TS/Python asymmetry explicitly.

    The TS backfill (``packages/agents/src/materialize-agent-package.ts:
    backfillPublishedMarkers``) also rewrites stale
    ``.cinatra-published.json`` markers (sha mismatch / malformed JSON /
    missing required keys), guarded by the ``.cinatra-in-progress.json``
    draft marker.

    The Python ``_backfill_missing_markers`` stays MISSING-ONLY because
    the wayflow container mounts ``./agents:/agents:ro`` and cannot
    write. The TS backfill runs first at boot (from
    ``src/instrumentation.node.ts``) so any stale markers are already
    repaired by the time the wayflow loader scans.

    This test pins the Python behavior so a future contributor who
    looks at the TS rewrite and "fixes" the Python side to match does
    not silently break the read-only invariant. Companion to
    ``packages/agents/src/__tests__/backfill-stale-marker-rewrite.test.ts``
    on the TS side.
    """
    _seed_agent(tmp_path, "cinatra", "asym")
    slug_dir = tmp_path / "cinatra" / "asym"
    _write_marker(
        slug_dir,
        package_name="@cinatra/asym",
        package_version="1.0.0",
        oas_sha="0" * 64,  # deliberately stale
    )
    marker_path = slug_dir / _PUBLISHED_MARKER_FILENAME
    before = marker_path.read_text(encoding="utf-8")

    written = _backfill_missing_markers(tmp_path)

    # Python does NOT count a rewrite — written stays 0 even though
    # the sha is stale. The loader's marker_check later emits a
    # `hash_mismatch` verdict and gates the agent; the operator must
    # rely on the TS backfill (or a manual rm) for auto-repair.
    assert written == 0
    after = marker_path.read_text(encoding="utf-8")
    assert before == after, (
        "Python backfill must not rewrite stale "
        "markers — the TS host-side backfill owns that responsibility"
    )


def test_backfill_resolves_package_version_from_package_json(
    tmp_path: Path,
) -> None:
    """Backfill cascade picks `version` from sibling `package.json` first."""
    _seed_agent(tmp_path, "cinatra", "with-pkg-json")
    slug_dir = tmp_path / "cinatra" / "with-pkg-json"
    pkg_json_path = slug_dir / "package.json"
    pkg_json_path.write_text(
        json.dumps({"name": "@cinatra/with-pkg-json", "version": "2.4.1"}),
        encoding="utf-8",
    )

    written = _backfill_missing_markers(tmp_path)
    assert written == 1

    marker = json.loads(
        (slug_dir / _PUBLISHED_MARKER_FILENAME).read_text(encoding="utf-8")
    )
    assert marker["packageVersion"] == "2.4.1"


def test_backfill_falls_back_to_oas_metadata_when_package_json_absent(
    tmp_path: Path,
) -> None:
    """When `package.json` is absent BUT OAS metadata has
    `packageVersion`, the cascade picks up the OAS metadata value
    (cascade step 2).
    """
    oas_path = _seed_agent(tmp_path, "cinatra", "oas-version")
    # Inject metadata.cinatra.packageVersion explicitly.
    body = json.loads(oas_path.read_text(encoding="utf-8"))
    body.setdefault("metadata", {}).setdefault("cinatra", {})[
        "packageVersion"
    ] = "3.1.4"
    oas_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")

    written = _backfill_missing_markers(tmp_path)
    assert written == 1

    slug_dir = tmp_path / "cinatra" / "oas-version"
    marker = json.loads(
        (slug_dir / _PUBLISHED_MARKER_FILENAME).read_text(encoding="utf-8")
    )
    assert marker["packageVersion"] == "3.1.4"


def test_backfill_falls_back_to_literal_when_no_version_source(
    tmp_path: Path,
) -> None:
    """When `package.json` is absent AND OAS metadata has no
    `packageVersion`, the cascade falls back to "0.0.0-backfill"
    (cascade step 3).
    """
    oas_path = _seed_agent(tmp_path, "cinatra", "no-version")
    # Strip any packageVersion that the sample OAS might carry.
    body = json.loads(oas_path.read_text(encoding="utf-8"))
    meta = body.setdefault("metadata", {}).setdefault("cinatra", {})
    meta.pop("packageVersion", None)
    oas_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")

    written = _backfill_missing_markers(tmp_path)
    assert written == 1

    slug_dir = tmp_path / "cinatra" / "no-version"
    marker = json.loads(
        (slug_dir / _PUBLISHED_MARKER_FILENAME).read_text(encoding="utf-8")
    )
    assert marker["packageVersion"] == "0.0.0-backfill"


# ---------------------------------------------------------------------------
# Marker-gated mount via build_parent_app — end-to-end.
# ---------------------------------------------------------------------------


def test_build_parent_app_backfills_then_mounts(tmp_path: Path) -> None:
    """End-to-end: `build_parent_app` backfills the marker for any unmarked
    dir AND then mounts the agent during the subsequent `discover_agents`
    pass. This is the rollout-day behavior.
    """
    _seed_agent(tmp_path, "cinatra", "rollout")
    marker_path = (
        tmp_path / "cinatra" / "rollout" / _PUBLISHED_MARKER_FILENAME
    )
    assert not marker_path.exists()

    app = build_parent_app(tmp_path)
    # Marker should now exist on disk.
    assert marker_path.exists()
    # The agent should be in the registry's _pending dict (initial mount
    # before lifespan startup).
    registry = app.state.registry  # type: ignore[attr-defined]
    assert "cinatra/rollout" in registry._pending  # noqa: SLF001
