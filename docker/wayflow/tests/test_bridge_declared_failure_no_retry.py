"""A model step that answered a failure runs ONCE (cinatra#4220).

When a bridge step's model answers a failure (a non-empty ``error.code`` the
step does not list in ``completed_error_codes``), /api/llm-bridge answers HTTP
422 with ``{"code": "STEP_DECLARED_FAILURE", "stepErrorCode", "message"}``.
That answer is final. The pinned WayFlow ``ApiCallStep`` sends every non-2xx
answer up to three times, so without the loader's stop a failed step would ask
the model three times and only then fail, with the raw
``error executing POST request ...: 422, {...}`` text as the run's error.

These tests drive the REAL ``ApiCallStep`` of the pinned wayflowcore, patched by
``_patch_api_call_step_bridge_token``. Only the network is replaced: the step's
own ``httpx.AsyncClient`` gets a transport that counts the requests it receives:

  - a STEP_DECLARED_FAILURE answer is requested once and ends the step with the
    bridge's own sentence;
  - every other non-2xx answer (another 422, a 500) keeps WayFlow's three tries;
  - the same answer from a host other than CINATRA_BASE_URL is not stopped.
"""

from __future__ import annotations

import asyncio
import json
import warnings
from typing import Any, Dict, Iterator, List

import pytest

pytest.importorskip("wayflowcore")

import httpx  # noqa: E402 — wayflowcore brings it

BRIDGE_TOKEN = "declared-failure-test-token"
FAILURE_MESSAGE = "The page could not be read: the site answered 404."
APP_BASE_URL = "http://cinatra-app.test:3000"
OTHER_BASE_URL = "http://cinatra-app.test:3001"


class _CountingBridge:
    """Stands in for the app: answers one fixed status and JSON body, counts.

    ``ApiCallStep`` builds its own ``httpx.AsyncClient()``; the fixture hands
    that client this transport, so the step's real client, auth hook and retry
    loop run unchanged and only the network is replaced.
    """

    def __init__(self) -> None:
        self.status = 200
        self.body: Dict[str, Any] = {}
        self.requests: List[httpx.Request] = []
        self.transport = httpx.MockTransport(self._answer)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)


@pytest.fixture
def bridge(monkeypatch: pytest.MonkeyPatch) -> Iterator[_CountingBridge]:
    counting = _CountingBridge()
    real_client = httpx.AsyncClient

    def client_on_the_counting_bridge(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = counting.transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_on_the_counting_bridge)
    yield counting


def _patch_loader(monkeypatch: pytest.MonkeyPatch, base_url: str) -> Any:
    """Apply the loader's ApiCallStep patch afresh against ``base_url``."""
    from wayflowcore.steps import ApiCallStep

    import agent_loader

    pristine = ApiCallStep._execute_request
    while getattr(pristine, "__cinatra_patched__", False):
        pristine = pristine.__wrapped__
    # monkeypatch restores whatever the class held before this test.
    monkeypatch.setattr(ApiCallStep, "_execute_request", pristine)

    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", BRIDGE_TOKEN)
    monkeypatch.setenv("CINATRA_BASE_URL", base_url)
    monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)

    agent_loader._patch_api_call_step_bridge_token()
    assert getattr(ApiCallStep._execute_request, "__cinatra_patched__", False)
    return ApiCallStep


def _run_step(api_call_step: Any) -> Any:
    step = api_call_step(
        url=f"{APP_BASE_URL}/api/llm-bridge",
        method="POST",
        data={
            "system": "Read the page.",
            "user": "page 42",
            "completed_error_codes": ["reread_failed"],
        },
        allow_insecure_http=True,
        store_response=True,
    )
    with warnings.catch_warnings():
        # WayFlow warns about allow_insecure_http; the test host is plain http.
        warnings.simplefilter("ignore")
        return asyncio.run(step._invoke_step_async({}, None))


def test_declared_failure_is_requested_once_and_ends_with_the_bridge_sentence(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = {
        "error": "The step answered a failure",
        "code": "STEP_DECLARED_FAILURE",
        "stepErrorCode": "read-failed",
        "message": FAILURE_MESSAGE,
    }
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1, "a step that answered a failure is not asked again"
    assert str(raised.value) == FAILURE_MESSAGE
    sent = bridge.requests[0]
    assert sent.url.path == "/api/llm-bridge"
    assert sent.headers.get("X-Cinatra-Bridge-Token") == BRIDGE_TOKEN
    assert json.loads(sent.content)["completed_error_codes"] == ["reread_failed"]


def test_declared_failure_without_a_message_names_the_step_code(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "call_failed"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1
    assert str(raised.value) == "The step answered the error code call_failed."


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (422, {"error": "Invalid request body"}),
        (422, {"code": "SOMETHING_ELSE", "message": "not a step failure"}),
        (500, {"error": "Internal error"}),
        (503, {"code": "STEP_DECLARED_FAILURE", "message": "wrong status"}),
    ],
)
def test_every_other_failed_answer_keeps_three_tries(
    monkeypatch: pytest.MonkeyPatch,
    bridge: _CountingBridge,
    status: int,
    body: Dict[str, Any],
) -> None:
    bridge.status = status
    bridge.body = body
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 3
    assert str(raised.value).startswith("error executing POST request to ")


def test_the_stop_covers_the_internal_bridge_only(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "message": FAILURE_MESSAGE}
    # CINATRA_BASE_URL names another port, so this answer is NOT the app's.
    step_class = _patch_loader(monkeypatch, OTHER_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 3
    assert "X-Cinatra-Bridge-Token" not in bridge.requests[0].headers
    assert str(raised.value).startswith("error executing POST request to ")


def test_a_successful_answer_is_unchanged(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 200
    bridge.body = {"title": "Hello", "error": {"code": "", "message": ""}}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    result = _run_step(step_class)

    assert len(bridge.requests) == 1
    assert result.outputs[step_class.HTTP_STATUS_CODE] == 200
    assert json.loads(result.outputs[step_class.HTTP_RESPONSE]) == bridge.body
