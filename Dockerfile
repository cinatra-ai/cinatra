# Cinatra — minimal Docker image
# Build:  docker build -t cinatra .
# Run:    docker run -p 3000:3000 --env-file .env.local cinatra

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# .pnpmfile.cjs is required at install time: the lockfile records its checksum,
# and its readPackage hook re-hydrates the cloned extensions' first-party "*"
# specs to workspace:* so they link the workspace SDK packages.
# cinatra-required-extensions.lock.json drives the acquire step below; copying
# it in this layer makes a lock bump cache-bust the acquisition.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs cinatra-required-extensions.lock.json ./
COPY packages packages
COPY patches patches
# Root postinstall hook (scripts/vendor-anthropic-skills.mjs) runs during
# pnpm install and needs the scripts/ tree available at install time, not
# only after the later `COPY . .`. Copying it here preserves the lockfile-
# only cache-bust for the install layer when only scripts/ changes.
COPY scripts scripts

# Two-phase install around the pinned extension acquisition:
#   1. first frozen install WITHOUT extensions/ — pnpm tolerates the missing
#      workspace members (it lays down dangling extension symlinks) and this
#      install provides the root `tar` dependency + the exact-pinned published
#      CLI (@cinatra-ai/cinatra, a root devDependency) at node_modules/.bin/cinatra;
#   2. acquire the required-extension bootable set from the committed lock —
#      codeload tarballs pinned to commit SHAs, hardened extraction, tree-hash
#      + package.json verification (@cinatra-ai/cinatra's prod-extension-acquisition).
#      Any network / 404 / integrity failure FAILS the image build right here;
#   3. second frozen install links the now-present extension packages so their
#      workspace SDK deps resolve (else the later `next build` cannot).
# The build context never supplies extensions/ (.dockerignore excludes it);
# the verified in-image acquisition is the only source of extension code.
# The CLI itself is the published @cinatra-ai/cinatra@<pinned> (cinatra#402 P2),
# resolved from the lockfile (NOT npx/`latest`) for reproducible prod builds.
RUN pnpm install --frozen-lockfile
RUN pnpm exec cinatra extensions acquire-prod
RUN pnpm install --frozen-lockfile

# Materialize a self-contained, symlink-free copy of the published CLI for the
# runtime stage. `.next/standalone` only carries SERVER-traced node_modules, so
# the CLI (a devDependency, never imported by server.js) would otherwise be
# absent from the runtime image. `cp -RL` DEREFERENCES pnpm's virtual-store
# symlink so the copied tree is real files (a plain `COPY node_modules/...`
# would copy a dangling .pnpm symlink). The CLI's own deps (pacote/pg/semver/
# tar/@modelcontextprotocol/sdk, node-pg-migrate via @cinatra-ai/migrations) are
# already in the standalone-traced node_modules — the materialized CLI resolves
# them by walking up to /app/node_modules at runtime, exactly as the old in-repo
# packages/cli did. See the runtime-stage COPY below.
RUN cp -RL node_modules/@cinatra-ai/cinatra /app/.cinatra-cli

# Required-extension OAS seed for deploy-refreshable materialization
# (cinatra-ai/ops#436). `acquire-prod` (above) materialized the SHA-pinned
# required set into /app/extensions, but the runtime stage never copies
# /app/extensions (it is .dockerignore-excluded and not server-traced into
# .next/standalone), so the required-set `<vendor>/<slug>/cinatra/oas.json`
# trees that WayFlow + the host scan would be absent in the runtime image — and
# when a deploy mounts a persistent volume over the install dir (ops#431), the
# trees freeze, never refreshed by a new tag. This projects a SYMLINK-FREE,
# image-owned seed (just cinatra/**, skills/**, package.json + an ownership
# marker per slug) that a PROD boot phase reconciles into the live install dir,
# making the required set materializable on every deploy. Built here (scripts/
# is present from the earlier COPY; /app/extensions still holds the acquired
# set — `.dockerignore` keeps the later `COPY . .` from clobbering it).
RUN node scripts/extensions/build-required-oas-seed.mjs \
      --source /app/extensions --out /app/.cinatra-required-oas-seed

COPY . .

# Presence-aware map regeneration (cinatra#7). `COPY . .` restored the
# COMMITTED src/lib/generated/* maps — the dev/CI-canonical artifact generated
# against the full clone-back extension universe. THIS image's presence
# universe is the lock-acquired required set (the acquire step above), so the
# maps are regenerated here against the extension tree actually in the image:
# `next build` can then never compile a literal import the acquired set does
# not ship (the #109/#110 fresh-clone failure class, structurally removed for
# the image surface). The follow-up `--check --self` is the NON-CANONICAL
# self-check mode: it verifies the regenerated output + catalog parity for
# THIS tree and deliberately never binds the committed maps. Both steps fail
# the image build loudly on any error (fail-closed).
RUN node scripts/extensions/generate-extension-manifest.mjs \
 && node scripts/extensions/generate-extension-manifest.mjs --check --self

# Bundle the Better Auth migration runner into a SELF-CONTAINED .mjs (better-auth
# + pg + the shared plugin factory inlined). The Next standalone runtime image
# only ships server-traced node_modules, which excludes better-auth (used by the
# migrate runner, not the server) — so the loose scripts/better-auth-migrate.mts
# cannot resolve it there and `setup prod` fails on a FRESH DB. Bundling here
# (full node_modules present, AFTER `COPY . .` so src/lib is available) makes the
# runner independent of the pruned tree. The published @cinatra-ai/cinatra CLI's
# `setup prod` prefers this bundle over the loose .mts when present.
RUN pnpm build:auth-migrate-bundle

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cinatra is a large Next app (many workspace packages). Default Node heap
# (~1.5 GB on a 2-core builder) OOMs during Turbopack compile.
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Next collects page data by importing route modules at build time. A few
# cinatra modules throw at import if their env var is missing. Set inert
# placeholders inline on this RUN so they don't persist in image layers.
# Next only inlines NEXT_PUBLIC_* vars; all other process.env reads happen
# at runtime against the real environment.
# CI=true (forwarded as a build-arg ONLY from the CI docker build, see
# build-image.yml) makes next.config skip the redundant in-build tsc — types are
# gated by the separate REQUIRED typecheck job (which runs `next typegen` first).
# Empty by default so a local `docker build` keeps the in-build check as a safety net.
ARG CI=
RUN SUPABASE_DB_URL='postgresql://build:build@127.0.0.1:5432/build' \
    BETTER_AUTH_SECRET='build-only-placeholder-not-used-at-runtime' \
    NANGO_ENCRYPTION_KEY='build-only-placeholder-not-used-at-runtime' \
    OPENAI_API_KEY='build-only-placeholder-not-used-at-runtime' \
    CI="$CI" \
    pnpm build

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Next.js standalone output: server.js + traced node_modules (much smaller
# than copying the full node_modules tree).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Setup CLI — the published @cinatra-ai/cinatra (cinatra#402 P2), materialized
# symlink-free in the build stage. Placed at its canonical node_modules path so
# `node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs` resolves both the bin
# and its deps (the latter ride the standalone-traced node_modules copied above).
# For one-shot tasks via `docker exec`:
#   docker exec <cid> node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs setup prod
# (CINATRA_REPO_ROOT=/app is implicit — getRepoRoot() walks up from cwd=/app to
# the pnpm-workspace.yaml + packages/migrations sentinel; see below.)
COPY --from=build /app/.cinatra-cli ./node_modules/@cinatra-ai/cinatra

# Deploy-compat transition forwarder (cinatra#402 P2). External deploy tooling
# (cinatra-ai/ops: deploy-instance.sh, the staging/coolify docker-compose
# `setup prod` one-shots, setup-{prod,demo}-server.sh) still hardcodes the
# LEGACY path `node /app/packages/cli/bin/cinatra.mjs setup prod`. This ~5-line
# file (NOT the old CLI — it re-execs the published CLI copied above) keeps that
# path working so the image switch does not force a lockstep cross-repo deploy.
# Dropped in a later release once ops has migrated to the published-CLI path.
COPY --from=build /app/packages/cli/bin ./packages/cli/bin

# The migration runner package (@cinatra-ai/migrations, cinatra#403), which the
# CLI resolves from the checkout for `db migrate` / `setup`. Copied explicitly
# for TWO reasons:
#   1. `getRepoRoot()`'s checkout sentinel (in the published @cinatra-ai/cinatra
#      CLI) anchors on `packages/migrations/package.json` (the never-removed
#      internal marker that survives packages/cli going external at P1/P2).
#      Without this dir the sentinel fails and every repo-bound CLI command in
#      the image errors. (The other half of the sentinel, pnpm-workspace.yaml,
#      rides the standalone trace copied above.)
#   2. It carries the runner source the published CLI's checkout-resolved
#      `@cinatra-ai/migrations` import resolves to (its node-pg-migrate + pg deps
#      still ride the traced standalone node_modules below).
COPY --from=build /app/packages/migrations ./packages/migrations

# Core schema migrations (node-pg-migrate modules, cinatra#116). The boot pass
# and `cinatra db migrate` resolve migrations/core/ relative to /app; the
# @cinatra-ai/migrations runner + its node-pg-migrate dep ride the traced
# standalone node_modules.
COPY --from=build /app/migrations ./migrations

# Self-contained Better Auth migration runner (see build stage). The CLI prefers
# this bundle over the loose .mts when present; without it, `setup prod` on a
# fresh database cannot resolve better-auth in the standalone image.
COPY --from=build /app/scripts/better-auth-migrate.bundle.mjs ./scripts/better-auth-migrate.bundle.mjs

# Required-extension OAS seed (cinatra-ai/ops#436). The image-owned, symlink-free
# projection of the required set's agent OAS trees (built in the build stage from
# the acquired /app/extensions). The `required-extension-materialize` PROD boot
# phase reconciles this seed into the live agent-install dir on every boot, so a
# new image tag REFRESHES the on-disk trees WayFlow + the host scan rather than
# leaving them frozen in a persistent volume (the ops#431 regression). The phase
# is fail-closed in prod, so this COPY is load-bearing — without the seed a prod
# boot aborts.
COPY --from=build /app/.cinatra-required-oas-seed ./.cinatra-required-oas-seed

EXPOSE 3000
CMD ["node", "server.js"]
