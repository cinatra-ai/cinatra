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
#      install provides the root `tar` dependency + a runnable packages/cli;
#   2. acquire the required-extension bootable set from the committed lock —
#      codeload tarballs pinned to commit SHAs, hardened extraction, tree-hash
#      + package.json verification (packages/cli/src/prod-extension-acquisition.mjs).
#      Any network / 404 / integrity failure FAILS the image build right here;
#   3. second frozen install links the now-present extension packages so their
#      workspace SDK deps resolve (else the later `next build` cannot).
# The build context never supplies extensions/ (.dockerignore excludes it);
# the verified in-image acquisition is the only source of extension code.
RUN pnpm install --frozen-lockfile
RUN node packages/cli/bin/cinatra.mjs extensions acquire-prod
RUN pnpm install --frozen-lockfile

COPY . .

# Bundle the Better Auth migration runner into a SELF-CONTAINED .mjs (better-auth
# + pg + the shared plugin factory inlined). The Next standalone runtime image
# only ships server-traced node_modules, which excludes better-auth (used by the
# migrate runner, not the server) — so the loose scripts/better-auth-migrate.mts
# cannot resolve it there and `setup prod` fails on a FRESH DB. Bundling here
# (full node_modules present, AFTER `COPY . .` so src/lib is available) makes the
# runner independent of the pruned tree. See packages/cli runBetterAuthMigrate.
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

# Setup CLI — for one-shot tasks via `docker exec`:
#   docker exec <cid> node packages/cli/bin/cinatra.mjs setup prod
COPY --from=build /app/packages/cli ./packages/cli

# Core schema migrations (node-pg-migrate modules, cinatra#116). The boot pass
# and `cinatra db migrate` resolve migrations/core/ relative to /app; the
# node-pg-migrate package itself rides the traced standalone node_modules.
COPY --from=build /app/migrations ./migrations

# Self-contained Better Auth migration runner (see build stage). The CLI prefers
# this bundle over the loose .mts when present; without it, `setup prod` on a
# fresh database cannot resolve better-auth in the standalone image.
COPY --from=build /app/scripts/better-auth-migrate.bundle.mjs ./scripts/better-auth-migrate.bundle.mjs

EXPOSE 3000
CMD ["node", "server.js"]
