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

FROM python:3.11-slim

WORKDIR /app

# Pin wayflowcore[a2a]==26.1.1 (the [a2a] extra pulls fasta2a
# transitively).
# pyagentspec is a wayflowcore sub-dependency; pin it explicitly to prevent
# future rebuilds from pulling a version with breaking InputMessageNode
# validation (26.1.0 rejects inputs[] with title fields).
# starlette + uvicorn + asgi-lifespan support the multi-tenant parent app and
# tests. starlette is also a transitive dependency of wayflowcore[a2a] but we
# declare it explicitly so the import surface is stable. pytest-asyncio is
# required by the production test suite (asyncio_mode="auto").
RUN pip install --no-cache-dir \
    'wayflowcore[a2a]==26.1.1' \
    'pyagentspec==26.1.0' \
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
