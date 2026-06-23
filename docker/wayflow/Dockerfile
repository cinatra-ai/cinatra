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
# The DEFAULTS are the current production pins, so a plain `docker build` is
# byte-equivalent to before and green on main today. See docs/upgrade-track.md
# (python 3.11→3.14; wayflowcore/pyagentspec tracked as a unit).
ARG PYTHON_TAG=3.11-slim
ARG WAYFLOWCORE_VERSION=26.1.1
ARG PYAGENTSPEC_VERSION=26.1.0

FROM python:${PYTHON_TAG}

# Re-declare the ARGs AFTER FROM so they are visible in the build stage (Docker
# scopes a pre-FROM ARG to the FROM line only).
ARG WAYFLOWCORE_VERSION=26.1.1
ARG PYAGENTSPEC_VERSION=26.1.0

WORKDIR /app

# Pin wayflowcore[a2a] (the [a2a] extra pulls fasta2a transitively).
# pyagentspec is a wayflowcore sub-dependency; pin it explicitly to prevent
# future rebuilds from pulling a version with breaking InputMessageNode
# validation (26.1.0 rejects inputs[] with title fields).
# starlette + uvicorn + asgi-lifespan support the multi-tenant parent app and
# tests. starlette is also a transitive dependency of wayflowcore[a2a] but we
# declare it explicitly so the import surface is stable. pytest-asyncio is
# required by the production test suite (asyncio_mode="auto").
RUN pip install --no-cache-dir \
    "wayflowcore[a2a]==${WAYFLOWCORE_VERSION}" \
    "pyagentspec==${PYAGENTSPEC_VERSION}" \
    'pydantic>=2.0,<2.12' \
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
