"""cinatra local embedder — the vendor-free embedding floor (cinatra#2591).

WHY THIS SERVICE EXISTS
-----------------------
Graphiti ranks on EMBEDDINGS. Its embedder factory supports exactly four
providers — openai, azure_openai, gemini, voyage — and every one of them is a
paid hosted API. (`sentence-transformers` appears in upstream's `providers`
extra only for the local BGE cross-encoder, which is a RERANKER, not an
embedder; there is no local embedder provider in graphiti-core.) Anthropic
offers no embeddings API at all.

So without this service, an install that configures Anthropic for extraction
still cannot rank anything unless the operator ALSO signs up with OpenAI,
Voyage or Google purely to get vectors. That second-vendor requirement is what
cinatra#2591 calls the missing "embedder floor".

The seam that makes a local floor possible is upstream's OpenAI embedder
branch: it forwards `base_url` to the OpenAI SDK ("Support custom endpoints
like Ollama"). So anything that speaks the OpenAI `/v1/embeddings` contract can
BE the embedder. This is that thing: one small HTTP server wrapping a local
sentence-transformers model, baked into the image, no network at runtime, no
key, no vendor.

WHAT IT IS NOT. It is not a general OpenAI-compatible gateway: it implements
`/v1/embeddings` and `/health` and nothing else. It has no auth because it is
never published to a host interface — compose keeps it on the internal network
only (an `Authorization` header, if one arrives, is ignored, exactly as a local
Ollama would).

MODEL. `BAAI/bge-small-en-v1.5` via fastembed (ONNX runtime — no torch), 384
dimensions, ~130 MB, downloaded at BUILD time and cached in the image so a
container start needs no network and no Hugging Face reachability. The
dimension is reported by the model itself and is echoed in `/health`, because
the graphiti config must declare `embedder.dimensions` and a mismatch there
produces vectors the store silently cannot compare.
"""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from fastembed import TextEmbedding

LOG = logging.getLogger("kg-embedder")

MODEL_NAME = os.environ.get("KG_EMBEDDER_MODEL", "BAAI/bge-small-en-v1.5")
HOST = os.environ.get("KG_EMBEDDER_HOST", "0.0.0.0")
PORT = int(os.environ.get("KG_EMBEDDER_PORT", "8080"))
# A body larger than this is refused rather than embedded: the caller is
# graphiti, whose episode/summary strings are bounded, so a multi-megabyte body
# means something is wrong upstream and buffering it would be the failure.
MAX_BODY_BYTES = int(os.environ.get("KG_EMBEDDER_MAX_BODY_BYTES", str(8 * 1024 * 1024)))

_model: TextEmbedding | None = None
_dimensions: int | None = None


def model() -> TextEmbedding:
    """The process-wide model. Loaded once, lazily, from the baked cache."""
    global _model
    if _model is None:
        LOG.info("loading local embedding model %s", MODEL_NAME)
        _model = TextEmbedding(model_name=MODEL_NAME)
        LOG.info("local embedding model ready")
    return _model


def dimensions() -> int:
    """Embedding width, measured from the model rather than hard-coded."""
    global _dimensions
    if _dimensions is None:
        _dimensions = len(next(iter(model().embed(["dimension probe"]))))
    return _dimensions


def normalize_input(raw: Any) -> list[str]:
    """OpenAI's `input` accepts a string or an array of strings.

    Token-array inputs (the other shape the real API accepts) are REFUSED
    rather than guessed at: graphiti only ever sends text, and silently
    embedding a stringified list of integers would produce vectors that rank
    nonsense instead of failing.
    """
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list) and all(isinstance(item, str) for item in raw):
        return list(raw)
    raise ValueError("`input` must be a string or an array of strings")


def embed(texts: list[str]) -> list[list[float]]:
    return [list(map(float, vector)) for vector in model().embed(texts)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cinatra-kg-embedder"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - stdlib hook
        LOG.info("%s %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        # OpenAI's error envelope — the SDK on the other side reads `error.message`.
        self._send(status, {"error": {"message": message, "type": "invalid_request_error"}})

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"status": "ok", "model": MODEL_NAME, "dimensions": dimensions()})
            return
        self._error(404, f"no route {self.path}")

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        if self.path.rstrip("/") != "/v1/embeddings":
            self._error(404, f"no route {self.path}")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._error(400, "Content-Length is not a number")
            return
        if length <= 0:
            self._error(400, "empty request body")
            return
        if length > MAX_BODY_BYTES:
            self._error(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
            return

        try:
            payload = json.loads(self.rfile.read(length))
            # A body of `[]`, `null`, `3` or `"x"` is valid JSON and parses
            # fine, then has no `.get`. Left to raise, that AttributeError
            # escapes as a 500 with a traceback while every other malformed
            # input gets a 400 — the one shape of bad request that looks like a
            # server fault. It is a bad request like the rest of them.
            if not isinstance(payload, dict):
                self._error(400, "request body must be a JSON object")
                return
            texts = normalize_input(payload.get("input"))
        except (json.JSONDecodeError, ValueError) as exc:
            self._error(400, str(exc))
            return

        if not texts:
            self._error(400, "`input` must contain at least one string")
            return

        try:
            vectors = embed(texts)
        except Exception as exc:  # pragma: no cover - defensive
            LOG.exception("embedding failed")
            self._error(500, f"embedding failed: {exc}")
            return

        self._send(
            200,
            {
                "object": "list",
                # Echo the requested model name so a caller that asserts on it
                # sees its own value; `model_local` states what actually ran.
                "model": payload.get("model") or MODEL_NAME,
                "model_local": MODEL_NAME,
                "data": [
                    {"object": "embedding", "index": i, "embedding": v}
                    for i, v in enumerate(vectors)
                ],
                # The real API bills tokens; there is nothing to bill here and a
                # fabricated count would be a lie in a ledger, so both are zero.
                "usage": {"prompt_tokens": 0, "total_tokens": 0},
            },
        )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # Load before binding, so readiness means "can actually embed" rather than
    # "the port is open" — the exact distinction the old graphiti healthcheck
    # could not make.
    LOG.info("local embedder: model=%s dimensions=%d", MODEL_NAME, dimensions())
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    LOG.info("local embedder listening on %s:%d", HOST, PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
