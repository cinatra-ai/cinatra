# Execution-plane WORKER image (exec-plane L3, epic cinatra#1705).
#
# Build (from the repo root — the build context is the root, not this folder):
#   docker build -f docker/exec-worker/Dockerfile -t cinatra-exec-worker:dev .
#
# WHY A SEPARATE IMAGE AT ALL. The worker shells out to `docker` for every
# command it runs, so it needs a docker client and a docker socket. The app
# image is bare `FROM node:24-alpine` with no docker client, and the ops deploy
# guard refuses to hand an app container a socket in ANY class — deliberately,
# because a socket is root on the host. Putting the worker in the app image
# would have widened the app's blast radius to "root on the execution host" for
# no benefit. So: a slim image that carries the worker bundle, the gateway
# script, and a docker CLI — and NO app code, NO app env, no Next.js build, no
# extension tree, no database client.
#
# The broker deliberately does NOT ride here. It is pure Node (it opens the
# sealed carrier, authorizes, bounds load, audits, and talks mTLS), it rides in
# the app image, and since exec-plane L3 it routes its volume + container
# operations to THIS service over the typed seam
# (`EXEC_BROKER_VOLUME_OPS=worker-routed`) — which is what lets the socket live
# on exactly one container in the topology.

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# Same install shape as the app image MINUS the extension acquisition: the
# execution-plane package depends only on workspace siblings (@cinatra-ai/llm,
# @cinatra-ai/sdk-extensions), never on an extension. pnpm tolerates the absent
# extensions/* workspace members (the context excludes them) exactly as it does
# in the app image's first install phase.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs cinatra-required-extensions.lock.json ./
COPY packages packages
COPY patches patches
COPY scripts scripts
RUN pnpm install --frozen-lockfile

# The esbuild entry resolves `@cinatra-ai/llm/execution-plane` through the root
# tsconfig's `paths`, so the config has to be present before the bundle runs.
COPY tsconfig.json ./
RUN pnpm build:exec-service-bundle

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine
# docker-cli ONLY — not the daemon, not compose, not buildx. The worker's entire
# docker surface is the argv-only runner in `packages/execution-plane/src/docker-cli.ts`.
RUN apk add --no-cache docker-cli

WORKDIR /srv/exec-worker

# The worker service bundle. `build-exec-service-bundle.mjs` emits it as a
# self-contained ESM file precisely so no node_modules, no TypeScript and no
# workspace resolution has to exist in this image.
COPY --from=build /app/scripts/exec-worker-service.bundle.mjs ./worker-service.mjs

# The attributing egress gateway's runtime script. Until this image existed it
# was copied into NO image at all — local dev bind-mounts it from the workspace
# and production had nothing to mount. It rides here (read-only, alongside the
# worker) so the deployed `cinatra-exec-gateway` service can run the REAL
# gateway process instead of a stand-in. See `docker-compose.exec.yml`.
COPY --from=build /app/packages/execution-plane/runtime/egress-gateway.cjs \
     ./runtime/egress-gateway.cjs

ENV NODE_ENV=production

# ROOT, on purpose and with the reason written down: this container is given
# /var/run/docker.sock, and socket access IS root on the host. Dropping to an
# unprivileged UID that still has to reach the socket buys nothing but a false
# sense of containment, and pinning a `docker` group GID that matches the host's
# is a portability trap that fails closed at deploy time on the first host that
# numbers it differently. The real boundary is what this image does NOT contain:
# no app code, no app secrets, no app env — enforced by the compose scoping
# self-check (`scripts/audit/exec-compose-scoping-check.mjs`).
USER root

CMD ["node", "/srv/exec-worker/worker-service.mjs"]
