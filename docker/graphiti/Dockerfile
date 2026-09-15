# syntax=docker/dockerfile:1
#
# The knowledge-graph indexer: UPSTREAM Graphiti's own MCP server (cinatra#2591).
#
# WHY WE BUILD IT INSTEAD OF PULLING A TAG
# ----------------------------------------
# The service used to run `zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2`.
# That is Zep's published build of the SAME upstream source tree
# (getzep/graphiti `mcp_server/`), but it is published on the `mcp-v*` release
# cadence, not the graphiti-core cadence: the newest tag on Docker Hub is
# `1.0.2` / `1.0.2-graphiti-0.28.2`, pushed 2026-03-11, while graphiti-core has
# since shipped 0.29.0, 0.29.1, 0.29.2 and 0.29.3 (2026-07-27). Empirically
# re-verified 2026-08-10: the registry has NO tag newer than 1.0.2 and no
# `1.1.x`/`2.x` line. So "bump the pin" is not available — the only way to run
# the maintained server is to build the maintained source.
#
# Three concrete capabilities the 0.28.2 wrapper does not have, all of which
# cinatra#2591 requires:
#
#   1. A CUSTOM LLM BASE URL. The 1.0.2 factory built the OpenAI CoreLLMConfig
#      WITHOUT `base_url`, so extraction always went to api.openai.com and no
#      OpenAI-compatible stand-in could ever be used (this is exactly why
#      `scripts/ci/works-after/graphiti.sh` had to be excluded from the
#      secret-free CI set). The current source passes
#      `base_url=config.providers.openai.api_url` and switches to
#      `OpenAIGenericClient` when the URL is not an OpenAI domain.
#   2. `get_episode_entities` — episode -> (nodes, edges) PROVENANCE. This is
#      the mechanism cinatra#2591's deterministic row recovery is built on; it
#      does not exist in 1.0.x.
#   3. A real readiness route (`GET /health`). The old wrapper reported no
#      readiness at all, which is why the app could only ever say
#      "providerKey: configured|absent|unknown" and never "the indexer is up".
#
# PINNING. Both coordinates are build args and both are exact:
#   * GRAPHITI_UPSTREAM_REF — a full upstream COMMIT SHA (never a branch), so
#     the server source is immutable.
#   * GRAPHITI_CORE_VERSION — the graphiti-core release installed from PyPI.
# Bumping either is a deliberate edit here + a works-after graphiti run.
#
# WHAT IS DELIBERATELY NOT INSTALLED. Upstream's `providers` extra pulls
# `sentence-transformers` (and therefore torch, ~2.5 GB) for exactly ONE thing:
# the local BGE cross-encoder that `CrossEncoderFactory` falls back to when
# NEITHER the LLM nor the embedder provider has a native reranker. cinatra always
# configures the embedder as the `openai` provider shape (hosted OpenAI, or the
# local OpenAI-compatible `kg-embedder` service — see docker/kg-embedder), so
# `_reranker_for_provider('embedder', ...)` always returns an OpenAIRerankerClient
# and the BGE branch is unreachable. On top of that, the recall path
# (`search_nodes`) uses NODE_HYBRID_SEARCH_RRF, which is reciprocal-rank fusion
# and calls no cross-encoder at all. Installing torch to satisfy a branch that
# cannot be reached would add gigabytes for nothing. If a future change makes a
# non-openai-shaped embedder possible, add `sentence-transformers` back here in
# the same commit.

FROM python:3.12-slim-bookworm

# Upstream getzep/graphiti commit that supplies mcp_server/. Full SHA — a branch
# name here would silently un-pin the build.
ARG GRAPHITI_UPSTREAM_REF=425bf2481b51437e43455e09d241c5f46e3d95f3
# graphiti-core release installed from PyPI (upstream's own Dockerfiles do the
# same substitution; we pin the exact release rather than a floor).
ARG GRAPHITI_CORE_VERSION=0.29.3

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# uv, the package manager upstream's project metadata is written for.
ADD https://astral.sh/uv/install.sh /uv-installer.sh
RUN sh /uv-installer.sh && rm /uv-installer.sh

ENV PATH="/root/.local/bin:${PATH}" \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app/mcp

# The pinned upstream tree. codeload serves a commit tarball directly, so the
# build needs neither git nor a full clone.
ADD https://codeload.github.com/getzep/graphiti/tar.gz/${GRAPHITI_UPSTREAM_REF} /tmp/graphiti-src.tar.gz
RUN set -eu; \
    tar -xzf /tmp/graphiti-src.tar.gz -C /tmp; \
    cp -a "/tmp/graphiti-${GRAPHITI_UPSTREAM_REF}/mcp_server/." /app/mcp/; \
    rm -rf /tmp/graphiti-src.tar.gz "/tmp/graphiti-${GRAPHITI_UPSTREAM_REF}"

# Resolve dependencies against the PINNED graphiti-core from PyPI:
#   * drop upstream's [tool.uv.sources] path override (it points at the monorepo
#     checkout of graphiti-core, which is not in this build context);
#   * pin graphiti-core to the exact release WITH the neo4j extra (upstream's
#     own metadata carries the falkordb extra; cinatra runs Neo4j);
#   * drop sentence-transformers from the `providers` extra (see the header);
#   * raise `requires-python` to this image's interpreter and DELETE upstream's
#     `.python-version` (it pins 3.10). uv resolves against the LOWER bound and
#     against `.python-version`, so leaving either in place makes `uv lock` demand
#     a 3.10 interpreter that a python:3.12 image does not have — with
#     UV_PYTHON_DOWNLOADS=never (deliberate: no interpreter is fetched behind our
#     back) that is a hard build failure rather than a silent second runtime.
RUN set -eu; \
    sed -i '/\[tool\.uv\.sources\]/,/graphiti-core/d' pyproject.toml; \
    sed -i "s/graphiti-core\[falkordb\][>=]\+[0-9]\+\.[0-9]\+\.[0-9]\+/graphiti-core[neo4j]==${GRAPHITI_CORE_VERSION}/" pyproject.toml; \
    sed -i '/sentence-transformers/d' pyproject.toml; \
    sed -i 's/^requires-python = .*/requires-python = ">=3.12,<4"/' pyproject.toml; \
    rm -f .python-version; \
    grep -q "graphiti-core\[neo4j\]==${GRAPHITI_CORE_VERSION}" pyproject.toml \
      || { echo "ERROR: graphiti-core pin substitution did not apply — upstream pyproject.toml changed shape." >&2; exit 1; }; \
    rm -f uv.lock; \
    uv lock

# `providers` (minus sentence-transformers) supplies the Anthropic, Gemini, Groq
# and Voyage clients; `azure` supplies azure-identity. Dev tooling is excluded.
RUN uv sync --no-group dev --extra providers --extra azure

# Record both coordinates INSIDE the image so a running container can be asked
# what it is (the app's status surface reads them through /health + the labels).
RUN echo "${GRAPHITI_CORE_VERSION}" > /app/mcp/.graphiti-core-version \
    && echo "${GRAPHITI_UPSTREAM_REF}" > /app/mcp/.graphiti-upstream-ref

LABEL org.opencontainers.image.title="cinatra knowledge-graph indexer (upstream Graphiti MCP server)" \
      org.opencontainers.image.source="https://github.com/getzep/graphiti" \
      graphiti.upstream.ref="${GRAPHITI_UPSTREAM_REF}" \
      graphiti.core.version="${GRAPHITI_CORE_VERSION}"

EXPOSE 8000

# The upstream server exposes a real readiness route; the old wrapper did not,
# which is why compose used a bare TCP connect.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# CONFIG_PATH is set by compose to the mounted cinatra config; `--no-sync` keeps
# uv from re-resolving at container start.
CMD ["uv", "run", "--no-sync", "main.py"]
