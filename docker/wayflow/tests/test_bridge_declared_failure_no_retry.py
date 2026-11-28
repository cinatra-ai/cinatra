"""A model step that answered a failure runs ONCE (cinatra#4220).

When a bridge step's model answers a failure (a non-empty ``error.code`` the
step does not list in ``completed_error_codes``), /api/llm-bridge answers HTTP
422 with ``{"error", "code": "STEP_DECLARED_FAILURE", "stepErrorCode"}`` (no
model text).
That answer is final. The pinned WayFlow ``ApiCallStep`` sends every non-2xx
answer up to three times, so without the loader's stop a failed step would ask
the model three times and only then fail, with the raw
``error executing POST request ...: 422, {...}`` text as the run's error.

These tests drive the REAL ``ApiCallStep`` of the pinned wayflowcore, patched by
``_patch_api_call_step_bridge_token``. Only the network is replaced: the step's
own ``httpx.AsyncClient`` gets a transport that counts the requests it receives:

  - a STEP_DECLARED_FAILURE answer is requested once and ends the step with a
    StepDeclaredFailureError that carries the bridge's own sentence as data;
  - every other non-2xx answer (another 422, a 500) keeps WayFlow's three tries;
  - EVERY call the host compiler reads as a bridge call is stopped (its rule:
    the URL ends in /api/llm-bridge), on any host; a call to another path is
    not;
  - nothing on the step bypasses the stop: a request with an auth of its own
    keeps that auth and still stops (an httpx auth, a user and password pair,
    a callable, ``USE_CLIENT_DEFAULT``, a flow with a challenge round, on the
    async and the sync client; a flow that throws reaches the caller and a flow
    the stop ends is closed), and so does a step that takes bad answers itself
    (``ignore_bad_http_requests``);
  - the bridge token decides only the auth header: the stop is installed whether
    or not ``CINATRA_BRIDGE_TOKEN`` is set;
  - the error's text, and so every log line of the task runner, names only the
    escaped error code: the model's sentence reaches no log.
"""

from __future__ import annotations

import asyncio
import json
import warnings
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest

pytest.importorskip("wayflowcore")

import httpx  # noqa: E402 — wayflowcore brings it

BRIDGE_TOKEN = "declared-failure-test-token"
FAILURE_MESSAGE = "The page could not be read: the site answered 404."
APP_BASE_URL = "http://cinatra-app.test:3000"
OTHER_BASE_URL = "http://cinatra-app.test:3001"
OWN_AUTH_ERROR = "own-auth-flow-failed-4737"  # a marker the tests search for
DECLARED_FAILURE = {
    "error": "The step answered a failure",
    "code": "STEP_DECLARED_FAILURE",
    "stepErrorCode": "read-failed",
}
STOPPED_TEXT = "The step answered the error code read-failed."


class _CountingBridge:
    """Stands in for the app: answers one fixed status and JSON body, counts.

    A test may set ``script`` instead: the answers in order, the last one
    repeating (an own auth's challenge round reads two answers).

    ``ApiCallStep`` builds its own ``httpx.AsyncClient()``; the fixture hands
    that client this transport, so the step's real client, auth hook and retry
    loop run unchanged and only the network is replaced.
    """

    def __init__(self) -> None:
        self.status = 200
        self.body: Dict[str, Any] = {}
        self.script: List[Tuple[int, Dict[str, Any]]] = []
        self.requests: List[httpx.Request] = []
        self.transport = httpx.MockTransport(self._answer)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.script:
            status, body = self.script[min(len(self.requests), len(self.script)) - 1]
            return httpx.Response(status, json=body)
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


def _patch_loader(
    monkeypatch: pytest.MonkeyPatch,
    base_url: str,
    token: Optional[str] = BRIDGE_TOKEN,
) -> Any:
    """Apply the loader's ApiCallStep patch afresh against ``base_url``.

    ``token`` is the bridge token of the container's env; None leaves it unset.
    """
    from wayflowcore.steps import ApiCallStep

    import agent_loader

    pristine = ApiCallStep._execute_request
    while getattr(pristine, "__cinatra_patched__", False):
        pristine = pristine.__wrapped__
    # monkeypatch restores whatever the class held before this test.
    monkeypatch.setattr(ApiCallStep, "_execute_request", pristine)

    if token is None:
        monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", token)
    monkeypatch.setenv("CINATRA_BASE_URL", base_url)
    monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)

    agent_loader._patch_api_call_step_bridge_token()
    assert getattr(ApiCallStep._execute_request, "__cinatra_patched__", False)
    return ApiCallStep


def _make_step(
    api_call_step: Any,
    path: str = "/api/llm-bridge",
    base_url: str = APP_BASE_URL,
    **step_kwargs: Any,
) -> Any:
    return api_call_step(
        url=f"{base_url}{path}",
        method="POST",
        data={
            "system": "Read the page.",
            "user": "page 42",
            "completed_error_codes": ["reread_failed"],
        },
        allow_insecure_http=True,
        store_response=True,
        **step_kwargs,
    )


def _run_step(
    api_call_step: Any,
    path: str = "/api/llm-bridge",
    base_url: str = APP_BASE_URL,
    **step_kwargs: Any,
) -> Any:
    step = _make_step(api_call_step, path, base_url, **step_kwargs)
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
    # The sentence travels as data; the error's text names only the code.
    assert raised.value.sentence == FAILURE_MESSAGE
    assert raised.value.step_error_code == "read-failed"
    assert str(raised.value) == "The step answered the error code read-failed."
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


def test_the_stop_covers_a_bridge_call_to_any_host(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "read-failed"}
    # CINATRA_BASE_URL names another port: the call gets no bridge token, but
    # the compiler reads it as a bridge call, so the stop still holds.
    step_class = _patch_loader(monkeypatch, OTHER_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1
    assert "X-Cinatra-Bridge-Token" not in bridge.requests[0].headers
    assert str(raised.value) == "The step answered the error code read-failed."


@pytest.mark.parametrize(
    "path",
    [
        "/prefix/api/llm-bridge",
        "/other?next=/api/llm-bridge",
    ],
)
def test_the_stop_covers_every_url_the_compiler_reads_as_a_bridge_call(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge, path: str
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "read-failed"}
    # Not the exact bridge path, but the URL ends in it: the compiler's rule.
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, path)

    assert len(bridge.requests) == 1
    assert str(raised.value) == "The step answered the error code read-failed."


@pytest.mark.parametrize(
    "path",
    [
        "/api/llm-bridge-shadow",
        "/api/llm-bridge/more",
        "/api/llm-bridge?step=1",
    ],
)
def test_a_url_the_compiler_does_not_read_as_a_bridge_call_keeps_three_tries(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge, path: str
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "read-failed"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, path)

    assert len(bridge.requests) == 3
    assert str(raised.value).startswith("error executing POST request to ")


def test_a_step_that_takes_bad_answers_itself_still_stops(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "read-failed"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, ignore_bad_http_requests=True)

    assert len(bridge.requests) == 1
    assert str(raised.value) == "The step answered the error code read-failed."


def _own_auth_first(monkeypatch: pytest.MonkeyPatch, step_class: Any, auth: Any) -> None:
    """Hand the patched call a request that carries an auth of its own."""
    patched = step_class._execute_request

    async def with_own_auth(self: Any, request: Dict[str, Any]) -> Any:
        request["auth"] = auth
        return await patched(self, request)

    monkeypatch.setattr(step_class, "_execute_request", with_own_auth)


def _set_header(request: httpx.Request) -> httpx.Request:
    request.headers["X-Own-Auth"] = "callable"
    return request


@pytest.mark.parametrize(
    ("auth", "header", "value"),
    [
        (httpx.BasicAuth("user", "pass"), "Authorization", "Basic dXNlcjpwYXNz"),
        (("user", "pass"), "Authorization", "Basic dXNlcjpwYXNz"),
        (_set_header, "X-Own-Auth", "callable"),
    ],
)
def test_a_request_with_its_own_auth_keeps_it_and_still_stops(
    monkeypatch: pytest.MonkeyPatch,
    bridge: _CountingBridge,
    auth: Any,
    header: str,
    value: str,
) -> None:
    bridge.status = 422
    bridge.body = {"code": "STEP_DECLARED_FAILURE", "stepErrorCode": "read-failed"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, auth)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1
    assert bridge.requests[0].headers.get(header) == value
    assert str(raised.value) == "The step answered the error code read-failed."


def test_an_own_auth_of_another_kind_is_refused_before_it_is_sent(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 200
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, 42)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert bridge.requests == []
    assert "refused before it is sent" in str(raised.value)


@pytest.mark.parametrize("auth", [httpx.USE_CLIENT_DEFAULT, None], ids=["USE_CLIENT_DEFAULT", "None"])
def test_a_request_with_no_own_auth_in_either_spelling_still_stops(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge, auth: Any
) -> None:
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, auth)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1
    assert "Authorization" not in bridge.requests[0].headers
    assert str(raised.value) == STOPPED_TEXT


class _ChallengeAuth(httpx.Auth):
    """An own auth with a challenge round: a 401 answer gets a SECOND request, a copy
    that carries the credential (the first request object stays as it was sent)."""

    def auth_flow(self, request: httpx.Request) -> Iterator[httpx.Request]:
        response = yield request
        if response.status_code == 401:
            second = httpx.Request(
                request.method, request.url, headers=request.headers, content=request.content
            )
            second.headers["Authorization"] = "Bearer second"
            yield second


def test_an_own_auth_challenge_round_sends_both_requests_and_the_stop_reads_the_second_answer(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.script = [(401, {"error": "Unauthorized"}), (422, dict(DECLARED_FAILURE))]
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, _ChallengeAuth())

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 2
    assert "Authorization" not in bridge.requests[0].headers
    assert bridge.requests[1].headers.get("Authorization") == "Bearer second"
    assert str(raised.value) == STOPPED_TEXT


def test_an_own_auth_challenge_round_that_succeeds_returns_the_answer(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.script = [(401, {"error": "Unauthorized"}), (200, {"title": "Hello"})]
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, _ChallengeAuth())

    result = _run_step(step_class)

    assert len(bridge.requests) == 2
    assert bridge.requests[1].headers.get("Authorization") == "Bearer second"
    assert json.loads(result.outputs[step_class.HTTP_RESPONSE]) == {"title": "Hello"}


class _BrokenAuth(httpx.Auth):
    """An own auth whose flow throws, before its first request or after its first answer."""

    def __init__(self, after_first_answer: bool) -> None:
        self.after_first_answer = after_first_answer

    def auth_flow(self, request: httpx.Request) -> Iterator[httpx.Request]:
        if not self.after_first_answer:
            raise RuntimeError(OWN_AUTH_ERROR)
        yield request
        raise RuntimeError(OWN_AUTH_ERROR)


@pytest.mark.parametrize(
    ("after_first_answer", "sent"),
    [(False, 0), (True, 1)],
    ids=["before the first request", "after the first answer"],
)
def test_an_own_auth_flow_that_throws_reaches_the_caller_and_is_no_declared_failure(
    monkeypatch: pytest.MonkeyPatch,
    bridge: _CountingBridge,
    after_first_answer: bool,
    sent: int,
) -> None:
    bridge.status = 200
    bridge.body = {"title": "Hello"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    _own_auth_first(monkeypatch, step_class, _BrokenAuth(after_first_answer))

    with pytest.raises(Exception) as raised:
        _run_step(step_class)

    import agent_loader

    assert OWN_AUTH_ERROR in str(raised.value)
    assert not isinstance(raised.value, agent_loader.StepDeclaredFailureError)
    assert len(bridge.requests) == sent


class _TrackedAuth(httpx.Auth):
    """An own auth that records that its flow ended, so a closed flow can be read."""

    def __init__(self) -> None:
        self.ended: List[str] = []

    def sync_auth_flow(self, request: httpx.Request) -> Iterator[httpx.Request]:
        try:
            yield request
        finally:
            self.ended.append("sync")

    async def async_auth_flow(self, request: httpx.Request) -> Any:
        try:
            yield request
        finally:
            self.ended.append("async")


def test_an_own_auth_flow_is_closed_when_the_stop_ends_the_step(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)
    own = _TrackedAuth()
    _own_auth_first(monkeypatch, step_class, own)
    step = _make_step(step_class)

    async def drive() -> List[str]:
        # Read the own flow INSIDE the loop, as the step's error leaves it: a flow
        # left to the garbage collector would still be open here (its cleanup would
        # run only when the loop shuts down its async generators).
        try:
            await step._invoke_step_async({}, None)
        except RuntimeError as failure:
            assert str(failure) == STOPPED_TEXT
            return list(own.ended)
        raise AssertionError("the step did not fail")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert asyncio.run(drive()) == ["async"]
    assert len(bridge.requests) == 1


# ---------------------------------------------------------------------------
# The sync client. The hook serves both clients: httpx calls sync_auth_flow on
# an httpx.Client. These tests build the hook as the loader does and drive a
# real httpx.Client over the same counting transport (no ApiCallStep needed).
# ---------------------------------------------------------------------------


def _sync_call(bridge: _CountingBridge, own_auth: Any) -> httpx.Response:
    import agent_loader

    hook = agent_loader._step_declared_failure_auth(own_auth)
    with httpx.Client(transport=bridge.transport) as client:
        return client.post(f"{APP_BASE_URL}/api/llm-bridge", json={}, auth=hook)


def test_the_sync_flow_stops_at_a_declared_failure(bridge: _CountingBridge) -> None:
    import agent_loader

    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)

    with pytest.raises(agent_loader._StepDeclaredFailureAnswer) as raised:
        _sync_call(bridge, None)

    assert len(bridge.requests) == 1
    assert isinstance(raised.value.failure, agent_loader.StepDeclaredFailureError)
    assert str(raised.value.failure) == STOPPED_TEXT


def test_the_sync_flow_passes_another_answer_on(bridge: _CountingBridge) -> None:
    bridge.status = 422
    bridge.body = {"error": "Invalid request body"}

    response = _sync_call(bridge, None)

    assert response.status_code == 422
    assert len(bridge.requests) == 1


@pytest.mark.parametrize(
    ("auth", "header", "value"),
    [
        (httpx.BasicAuth("user", "pass"), "Authorization", "Basic dXNlcjpwYXNz"),
        (("user", "pass"), "Authorization", "Basic dXNlcjpwYXNz"),
        (_set_header, "X-Own-Auth", "callable"),
    ],
)
def test_the_sync_flow_keeps_an_own_auth_and_still_stops(
    bridge: _CountingBridge, auth: Any, header: str, value: str
) -> None:
    import agent_loader

    bridge.status = 200
    bridge.body = {"title": "Hello"}
    assert _sync_call(bridge, auth).status_code == 200
    assert bridge.requests[0].headers.get(header) == value

    bridge.requests.clear()
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    with pytest.raises(agent_loader._StepDeclaredFailureAnswer):
        _sync_call(bridge, auth)
    assert len(bridge.requests) == 1
    assert bridge.requests[0].headers.get(header) == value


def test_the_sync_flow_runs_an_own_auth_challenge_round_and_stops_at_the_second_answer(
    bridge: _CountingBridge,
) -> None:
    import agent_loader

    bridge.script = [(401, {"error": "Unauthorized"}), (422, dict(DECLARED_FAILURE))]

    with pytest.raises(agent_loader._StepDeclaredFailureAnswer):
        _sync_call(bridge, _ChallengeAuth())

    assert len(bridge.requests) == 2
    assert bridge.requests[1].headers.get("Authorization") == "Bearer second"


@pytest.mark.parametrize(
    ("after_first_answer", "sent"),
    [(False, 0), (True, 1)],
    ids=["before the first request", "after the first answer"],
)
def test_the_sync_flow_lets_an_own_auth_error_through_unchanged(
    bridge: _CountingBridge, after_first_answer: bool, sent: int
) -> None:
    bridge.status = 200
    bridge.body = {"title": "Hello"}

    with pytest.raises(RuntimeError, match=OWN_AUTH_ERROR):
        _sync_call(bridge, _BrokenAuth(after_first_answer))

    assert len(bridge.requests) == sent


def test_the_sync_flow_closes_an_own_auth_flow_when_it_stops(bridge: _CountingBridge) -> None:
    import agent_loader

    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    own = _TrackedAuth()

    try:
        _sync_call(bridge, own)
    except agent_loader._StepDeclaredFailureAnswer:
        # Read as the stop's error leaves the client call: a flow left to the
        # garbage collector would still be open while the error is in flight.
        ended_with_the_error_in_flight = list(own.ended)
    else:
        raise AssertionError("the call did not stop")

    assert ended_with_the_error_in_flight == ["sync"]


# ---------------------------------------------------------------------------
# The bridge token decides only the auth header the wrapper adds: the stop is
# installed whether or not CINATRA_BRIDGE_TOKEN is set.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("base_url", [APP_BASE_URL, OTHER_BASE_URL], ids=["app host", "another host"])
def test_the_stop_holds_when_no_bridge_token_is_set(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge, base_url: str
) -> None:
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL, token=None)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, base_url=base_url)

    assert len(bridge.requests) == 1
    # No token, so the wrapper adds no auth header (or any other X-Cinatra-* one).
    assert not [h for h in bridge.requests[0].headers if h.lower().startswith("x-cinatra-")]
    assert str(raised.value) == STOPPED_TEXT


def test_with_no_bridge_token_an_own_auth_is_kept_and_the_stop_holds(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL, token=None)
    _own_auth_first(monkeypatch, step_class, httpx.BasicAuth("user", "pass"))

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    assert len(bridge.requests) == 1
    assert bridge.requests[0].headers.get("Authorization") == "Basic dXNlcjpwYXNz"
    assert str(raised.value) == STOPPED_TEXT


def test_with_no_bridge_token_a_call_the_compiler_does_not_read_as_a_bridge_call_keeps_three_tries(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL, token=None)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, "/api/llm-bridge-shadow")

    assert len(bridge.requests) == 3
    assert str(raised.value).startswith("error executing POST request to ")


def test_with_no_bridge_token_a_successful_answer_is_unchanged(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 200
    bridge.body = {"title": "Hello", "error": {"code": "", "message": ""}}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL, token=None)

    result = _run_step(step_class)

    assert len(bridge.requests) == 1
    assert json.loads(result.outputs[step_class.HTTP_RESPONSE]) == bridge.body


def test_a_patch_made_with_no_token_gives_way_to_a_later_patch_with_the_token(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    import agent_loader

    bridge.status = 422
    bridge.body = dict(DECLARED_FAILURE)
    step_class = _patch_loader(monkeypatch, APP_BASE_URL, token=None)
    without_token = step_class._execute_request

    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", BRIDGE_TOKEN)
    agent_loader._patch_api_call_step_bridge_token()
    with_token = step_class._execute_request

    # Replaced over the same original, not chained on top of the first wrapper.
    assert with_token is not without_token
    assert with_token.__wrapped__ is without_token.__wrapped__
    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)
    assert len(bridge.requests) == 1
    assert bridge.requests[0].headers.get("X-Cinatra-Bridge-Token") == BRIDGE_TOKEN
    assert str(raised.value) == STOPPED_TEXT

    # A later call with the token unset leaves the wrapper that holds the token alone.
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN")
    agent_loader._patch_api_call_step_bridge_token()
    assert step_class._execute_request is with_token


def test_the_model_sentence_reaches_no_log_line(
    monkeypatch: pytest.MonkeyPatch,
    bridge: _CountingBridge,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "LIVE-4220-SECRET-token-9f8e7d6c5b4a"  # a marker, not key-shaped
    sentence = (
        "The page could not be read.\n"
        "[agent_loader] _patched_run_task EXCEPTION task=forged: FORGED-LINE-4220\r\n"
        f"\x1b[31mCOLOUR-MARK-4220\x00nul\x07bell\x7fdel key={secret}"
    )
    bridge.status = 422
    bridge.body = {
        "code": "STEP_DECLARED_FAILURE",
        "stepErrorCode": "read-failed\r\nforged\x1b\x7f",
        "message": sentence,
    }
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class)

    import agent_loader

    failure = raised.value
    assert isinstance(failure, agent_loader.StepDeclaredFailureError)
    # The bounded sentence is still handed on, as data.
    assert failure.sentence == sentence.strip()
    assert len(bridge.requests) == 1

    # The task runner's two log sites print the error and its traceback.
    capsys.readouterr()  # drop the patch's own start-up lines
    agent_loader._print_task_exception("EXCEPTION", "task-4220", failure)
    agent_loader._print_task_exception("OUTER EXCEPTION", "task-4220", failure)
    logged = capsys.readouterr().out

    for text in (logged, str(failure), repr(failure)):
        assert secret not in text
        assert "COLOUR-MARK-4220" not in text and "FORGED-LINE-4220" not in text
        assert "could not be read" not in text
        assert not any(c in text for c in ("\r", "\x00", "\x07", "\x1b", "\x7f"))
    assert "task=forged" not in logged
    # Only the escaped code is named, on the log line itself.
    shown = "read-failed\\r\\nforged\\u001b\\u007f"
    assert str(failure) == f"The step answered the error code {shown}."
    assert "\n" not in str(failure) and "\n" not in repr(failure)
    first = logged.splitlines()[0]
    assert first == (
        "[agent_loader] _patched_run_task EXCEPTION task=task-4220: "
        f"The step answered the error code {shown}."
    )


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


# ---------------------------------------------------------------------------
# A fixed step that ends its run with a stated sentence (cinatra#4890): the
# passthrough's 403 ``run_fail_stated`` answer stops the step on the same hook.
# ---------------------------------------------------------------------------

PASSTHROUGH = "/api/agents/passthrough"
STATED_SENTENCE = "The reviewed proposal and the written page differ, so the run stops here."


def test_a_stated_run_failure_is_requested_once_and_ends_with_its_sentence(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 403
    bridge.body = {"error": STATED_SENTENCE, "code": "run_fail_stated"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, PASSTHROUGH)

    assert len(bridge.requests) == 1, "a stated run failure is not sent again"
    assert str(raised.value) == STATED_SENTENCE
    assert bridge.requests[0].url.path == PASSTHROUGH


def test_a_step_that_takes_bad_answers_itself_still_ends_with_the_stated_sentence(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 403
    bridge.body = {"error": STATED_SENTENCE, "code": "run_fail_stated"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, PASSTHROUGH, ignore_bad_http_requests=True)

    assert len(bridge.requests) == 1
    assert str(raised.value) == STATED_SENTENCE


@pytest.mark.parametrize(
    "sentence",
    ["", "First line.\nSecond line.", "Stop\x07 here.", "a" * 401, 42],
)
def test_a_stated_answer_outside_the_bounds_ends_once_with_the_fixed_sentence(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge, sentence: Any
) -> None:
    bridge.status = 403
    bridge.body = {"error": sentence, "code": "run_fail_stated"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, PASSTHROUGH)

    assert len(bridge.requests) == 1
    assert str(raised.value) == "The step ended the run with a failure."


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (403, {"error": "extension_data: the table is not declared"}),
        (403, {"error": STATED_SENTENCE, "code": "run_action_refused"}),
        (422, {"error": STATED_SENTENCE, "code": "run_fail_stated"}),
    ],
)
def test_every_other_passthrough_answer_keeps_three_tries(
    monkeypatch: pytest.MonkeyPatch,
    bridge: _CountingBridge,
    status: int,
    body: Dict[str, Any],
) -> None:
    bridge.status = status
    bridge.body = body
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, PASSTHROUGH)

    assert len(bridge.requests) == 3
    assert str(raised.value).startswith("error executing POST request to ")


def test_a_stated_answer_from_another_path_keeps_three_tries(
    monkeypatch: pytest.MonkeyPatch, bridge: _CountingBridge
) -> None:
    bridge.status = 403
    bridge.body = {"error": STATED_SENTENCE, "code": "run_fail_stated"}
    step_class = _patch_loader(monkeypatch, APP_BASE_URL)

    with pytest.raises(RuntimeError) as raised:
        _run_step(step_class, "/api/other")

    assert len(bridge.requests) == 3
    assert str(raised.value).startswith("error executing POST request to ")
