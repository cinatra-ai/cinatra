# Plane MCP bridge (demo auto-connect)

cinatra#1238; owner ruling 2026-07-23 (groganz) — the demo Plane posture is
**automatic**. This image lets the demo expose Plane's MCP tools to agents
without any manual token paste.

## What it is

The official Plane MCP server, [`makeplane/plane-mcp-server`](https://github.com/makeplane/plane-mcp-server),
only holds the Plane Personal Access Token (PAT) **server-side** in its `stdio`
transport. Its `http` transport is the multi-tenant hosted server (OAuth at
`/http/mcp`, PAT-header at `/http/api-key/mcp`) and needs per-request auth — which
the cinatra external-MCP row model (the bridge holds the key; the connector dials
it unauthenticated with a null `nangoConnectionId`) does not carry.

So this `Dockerfile` runs the stdio server behind
[`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy), which fronts it with the
modern **MCP Streamable-HTTP** transport at `/mcp` (SSE at `/sse`) on loopback.

Both images are **version-pinned + digest-bound**. Brittleness across Plane
versions is accepted for the demo profile (owner ruling); re-resolve at bump time
with `docker buildx imagetools inspect makeplane/plane-mcp-server:<tag>`.

## How the demo wires it

1. `docker compose --profile plane up -d` brings up Plane CE (loopback @ :3400).
2. `node scripts/fixtures/provision-plane.mjs` headlessly mints a dev/demo PAT
   (CSRF sign-in → `POST /api/users/api-tokens/`, version-pinned to Plane CE
   1.3.1, reuse-first) and writes:
   - `docker/plane-mcp/.plane-mcp.env` (gitignored) — `PLANE_API_KEY`,
     `PLANE_WORKSPACE_SLUG`, `PLANE_BASE_URL=http://api:8000` — the bridge's env.
   - `.env.local` — `PLANE_MCP_URL=http://localhost:3450/mcp` plus the demo
     admin creds the connector's dev-setup auto-connect reads.
3. `docker compose --profile plane-mcp up -d --build` starts this bridge holding
   that PAT.
4. On the next `pnpm dev`, the Plane connector's `dev-setup` hook probes
   `PLANE_MCP_URL` with the real MCP handshake and wires an enabled
   `external_mcp_servers` row (`transport: streamable-http`).

`make setup-demo` performs all of the above.

## Credentials

Dev/demo only, loopback + reserved-TLD (`.localhost`), **not secrets**. The PAT
lives only in the gitignored `.plane-mcp.env`. A real deployment uses the
connector's prod auto-connect (plane-connector#41), not this bridge image.
