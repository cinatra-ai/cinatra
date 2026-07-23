# Plane MCP bridge for the DEMO profile (cinatra#1238; owner ruling 2026-07-23
# (groganz) — Plane posture is AUTOMATIC).
#
# The OFFICIAL Plane MCP server (makeplane/plane-mcp-server) only holds the PAT
# server-side in its `stdio` transport — its `http` transport is the multi-tenant
# hosted server (OAuth `/http/mcp` + PAT-HEADER `/http/api-key/mcp`) and requires
# per-request auth, which the cinatra external-MCP row model (nangoConnectionId
# null, the bridge holds the key) does not carry. So we run the stdio server
# behind `mcp-proxy`, which fronts it with the MODERN MCP Streamable-HTTP
# transport at `/mcp` on loopback — the cinatra Plane connector dials it
# unauthenticated and the bridge holds the key.
#
# VERSION-PINNED to the immutable makeplane/plane-mcp-server release tag 0.2.11,
# digest-bound below (the digest is the binding pin, so the tag is elided from
# the FROM to keep it unambiguous). Plane's MCP tool surface + the internal Plane
# REST it drives are version-coupled; brittleness across Plane versions is
# ACCEPTED for the demo profile (owner ruling). Re-resolve at bump time:
#   docker buildx imagetools inspect makeplane/plane-mcp-server:<tag>
FROM makeplane/plane-mcp-server@sha256:1feb49a963de0e3e3a2178cd86c4b388c19ef7fddfd15a95f81f6bd71cb7a95e

# The base is python:3.11-slim with `uv` + the `plane_mcp` package installed
# system-wide; add the stdio<->Streamable-HTTP proxy. Pinned for reproducibility.
USER root
RUN uv pip install --system --no-cache "mcp-proxy==0.12.0"

EXPOSE 8211

# mcp-proxy runs the stdio Plane MCP server as a subprocess and fronts it with a
# Streamable-HTTP endpoint at `/mcp` (and SSE at `/sse`). `--pass-environment`
# forwards the container env (PLANE_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_BASE_URL
# from compose `env_file`) to the spawned stdio server, which reads its Plane
# credentials from there.
#
# Transport mode: the DEFAULT (stateful) Streamable-HTTP is used deliberately —
# it drives the canonical MCP lifecycle (initialize -> Mcp-Session-Id ->
# notifications/initialized -> tools/list), which is exactly what both the
# connector's dev-setup probe and the host's runtime `@modelcontextprotocol/sdk`
# client speak. (mcp-proxy's `--stateless` flips to session-less JSON, whose
# per-request lifecycle enforcement across separate POSTs is less predictable.)
ENTRYPOINT ["mcp-proxy"]
CMD ["--pass-environment", "--host=0.0.0.0", "--port=8211", "--", "python", "-m", "plane_mcp", "stdio"]
