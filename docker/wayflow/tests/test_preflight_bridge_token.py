"""_preflight_bridge_token tests.

The wayflow runtime authenticates EVERY callback to the host /api/llm-bridge
with X-Cinatra-Bridge-Token. When that secret is empty the bridge returns 403,
the agent produces no text, and the interactive widget content-edit surfaces
"(no response)" with no obvious cause. Historically the loader only WARNED and
kept serving, so the misconfiguration was invisible until a user hit it.

`_preflight_bridge_token` (called first in `main()`) turns that silent
downstream 403 into a LOUD boot failure: it sys.exit(1)s when the token is
unset / empty / whitespace-only, unless CINATRA_ALLOW_NO_BRIDGE_TOKEN=1 opts a
test harness out.
"""

import pytest


def test_preflight_exits_when_token_unset(monkeypatch, capsys):
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)
    monkeypatch.delenv("CINATRA_ALLOW_NO_BRIDGE_TOKEN", raising=False)

    from agent_loader import _preflight_bridge_token

    with pytest.raises(SystemExit) as excinfo:
        _preflight_bridge_token()
    assert excinfo.value.code == 1
    captured = capsys.readouterr()
    # Loud, actionable message on stderr.
    assert "CINATRA_BRIDGE_TOKEN" in captured.err
    assert "Refusing to start" in captured.err


def test_preflight_exits_when_token_whitespace_only(monkeypatch):
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "   ")
    monkeypatch.delenv("CINATRA_ALLOW_NO_BRIDGE_TOKEN", raising=False)

    from agent_loader import _preflight_bridge_token

    with pytest.raises(SystemExit) as excinfo:
        _preflight_bridge_token()
    assert excinfo.value.code == 1


def test_preflight_passes_when_token_present(monkeypatch):
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "tok-abc-123")
    monkeypatch.delenv("CINATRA_ALLOW_NO_BRIDGE_TOKEN", raising=False)

    from agent_loader import _preflight_bridge_token

    # Must NOT raise.
    _preflight_bridge_token()


def test_preflight_opt_out_allows_missing_token(monkeypatch):
    """CINATRA_ALLOW_NO_BRIDGE_TOKEN=1 lets an isolated harness boot tokenless."""
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)
    monkeypatch.setenv("CINATRA_ALLOW_NO_BRIDGE_TOKEN", "1")

    from agent_loader import _preflight_bridge_token

    # Opt-out short-circuits before the token check — no SystemExit.
    _preflight_bridge_token()
