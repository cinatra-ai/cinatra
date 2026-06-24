# WayFlow multi-tenant A2A peer container.
#
# Hosts WayFlow's A2A server with Cinatra-specific patches applied
# (X-Cinatra-Bridge-Token injection on ApiCallStep + httpx.AsyncClient,
# A2AAgent shared-conversation skip, A2AServer.serve_agent ApiNode-only
# bypass).
#
# The loader auto-discovers EVERY agent under
# /agents/<vendor>/<slug>/cinatra/oas.json and mounts each at
# /agents/<vendor>/<slug>/ via a parent Starlette app + isolated A2AServer
# ASGI sub-apps. There is no per-agent CMD baking; CINATRA_WAYFLOW_AGENT
# is no longer read.
#
# Session-sensitive values (bearer_token, agent_run_id, mcp_server_url,
# a2a_bearer_token) flow through the A2A task input, NOT environment
# variables — env vars are process-global and would leak between concurrent
# sessions.

# Upgrade-track candidate knobs (cinatra#352 works-after harness). These pin the
# Python image + the wayflowcore/pyagentspec versions as build-args so the
# major-upgrade lane can build a CANDIDATE image (e.g. PYTHON_TAG=3.14-slim,
# WAYFLOWCORE_VERSION=<next>) and run the works-after wayflow proof against it.
# The DEFAULTS are the current production pins, so a plain `docker build` matches
# what main ships and is green on the works-after wayflow proof. See
# docs/upgrade-track.md.
#
# Wayflow major-upgrade lane (cinatra#354): bumped the Python runtime major
# 3.11→3.14-slim and moved the wayflow deps to the current upstream release
# (wayflowcore 26.1.1→26.1.2, pyagentspec 26.1.0→26.1.2 — wayflowcore 26.1.2
# requires pyagentspec>=26.1.2, so the two move as a unit). wayflowcore exposes
# no major above 26.1.x upstream, so the runtime "major" here is the Python
# image major; the wayflow deps track to the latest patch in lockstep. The
# works-after wayflow proof (A2A message/send → completed) is the works-after
# gate for this bump (cinatra#352, the major-upgrade track).
ARG PYTHON_TAG=3.14-slim
ARG WAYFLOWCORE_VERSION=26.1.2
ARG PYAGENTSPEC_VERSION=26.1.2

FROM python:${PYTHON_TAG}

# Re-declare the ARGs AFTER FROM so they are visible in the build stage (Docker
# scopes a pre-FROM ARG to the FROM line only).
ARG WAYFLOWCORE_VERSION=26.1.2
ARG PYAGENTSPEC_VERSION=26.1.2

WORKDIR /app

# Pin wayflowcore[a2a] (the [a2a] extra pulls fasta2a transitively).
# pyagentspec is a wayflowcore sub-dependency; pin it explicitly so a rebuild
# resolves the exact validated version (wayflowcore 26.1.2 floors it at
# >=26.1.2; an unpinned resolve could otherwise drift to a future breaking
# InputMessageNode validation change).
# pydantic is floored at >=2.12.5 by pyagentspec 26.1.2 (it declares
# pydantic>=2.12.5,<2.14); wayflowcore 26.1.2 allows pydantic<3.0.0. The pin
# `>=2.12.5,<2.14` is the intersection and keeps pydantic on the v2 line. (The
# prior `<2.12` cap was for pyagentspec 26.1.0, which did not require >=2.12.5;
# bumped in cinatra#354 to satisfy pyagentspec 26.1.2's declared floor.)
# starlette + uvicorn + asgi-lifespan support the multi-tenant parent app and
# tests. starlette is also a transitive dependency of wayflowcore[a2a] but we
# declare it explicitly so the import surface is stable. pytest-asyncio is
# required by the production test suite (asyncio_mode="auto").
RUN pip install --no-cache-dir \
    "wayflowcore[a2a]==${WAYFLOWCORE_VERSION}" \
    "pyagentspec==${PYAGENTSPEC_VERSION}" \
    'pydantic>=2.12.5,<2.14' \
    'starlette' \
    'uvicorn' \
    'asgi-lifespan==2.1.0' \
    httpx \
    pytest \
    'pytest-asyncio==0.23.5'

COPY cinatra_executors/ ./cinatra_executors/
COPY agent_loader.py .
COPY tests/ ./tests/

ENV PYTHONUNBUFFERED=1
EXPOSE 3010

# No per-agent slug; the loader auto-discovers all agents from
# CINATRA_AGENTS_DIR (default /agents).
CMD ["python", "agent_loader.py"]
