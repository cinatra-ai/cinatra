"""_preflight_context_attest_key tests (#1192).

Symmetric with _preflight_bridge_token. The wayflow runtime signs the per-node
context-callback attestation with CINATRA_CONTEXT_ATTEST_KEY; without it every
composed-child context resolution 403s mid-run (leaf agents still work — the
silent partial-outage trap). `_preflight_context_attest_key` (called in main()
after the bridge-token preflight) turns that into a LOUD boot failure: sys.exit(1)
when the key is unset / empty / whitespace-only, unless
CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY=1 opts a harness out (loudly).
"""

import pytest


def test_preflight_exits_when_key_unset(monkeypatch, capsys):
    monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)
    monkeypatch.delenv("CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY", raising=False)

    from agent_loader import _preflight_context_attest_key

    with pytest.raises(SystemExit) as excinfo:
        _preflight_context_attest_key()
    assert excinfo.value.code == 1
    captured = capsys.readouterr()
    # Loud, actionable message on stderr.
    assert "CINATRA_CONTEXT_ATTEST_KEY" in captured.err
    assert "Refusing to start" in captured.err


def test_preflight_exits_when_key_whitespace_only(monkeypatch):
    monkeypatch.setenv("CINATRA_CONTEXT_ATTEST_KEY", "   ")
    monkeypatch.delenv("CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY", raising=False)

    from agent_loader import _preflight_context_attest_key

    with pytest.raises(SystemExit) as excinfo:
        _preflight_context_attest_key()
    assert excinfo.value.code == 1


def test_preflight_passes_when_key_present(monkeypatch):
    monkeypatch.setenv("CINATRA_CONTEXT_ATTEST_KEY", "attest-abc-123")
    monkeypatch.delenv("CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY", raising=False)

    from agent_loader import _preflight_context_attest_key

    # Must NOT raise.
    _preflight_context_attest_key()


def test_preflight_opt_out_allows_missing_key_loudly(monkeypatch, capsys):
    """CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY=1 boots keyless — but LOUDLY."""
    monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)
    monkeypatch.setenv("CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY", "1")

    from agent_loader import _preflight_context_attest_key

    # Opt-out short-circuits before the key check — no SystemExit.
    _preflight_context_attest_key()
    captured = capsys.readouterr()
    # The degraded posture is announced, not silent.
    assert "CINATRA_ALLOW_NO_CONTEXT_ATTEST_KEY=1" in captured.out
    assert "WITHOUT" in captured.out
