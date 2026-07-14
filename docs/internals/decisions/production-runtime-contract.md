# The production runtime contract: the container image is the supported target

- Status: RATIFIED — the released container image is the ONLY supported
  production runtime target; running production from a bare host checkout is
  UNSUPPORTED. Converged via Codex (read-only), not asserted unilaterally.
- Date: 2026-07-14
- Source: the prod-install epic (cinatra-ai/cinatra-cli#142); this is its S4
  prerequisite (cinatra-ai/cinatra#1576), which unblocks S3
  (cinatra-ai/cinatra-cli#145) and S5 (cinatra-ai/cinatra-cli#146).
- Applies to: **production deployment only.** Local development (`pnpm dev`,
  `make dev`, `cinatra instance start`) is unaffected by this ruling.

## The ruling

The **only supported production runtime target is the released container
image.** Production is delivered as `ghcr.io/cinatra-ai/cinatra:<version>`
(mirrored to the public `docker.io/cinatra/cinatra:<version>`) and run with the
image's own `CMD ["node", "server.js"]`.

Running the app in production **from a host checkout** — `next start`,
`pnpm start`, or a bare `node .next/standalone/server.js` **without** the
image's build-and-copy dance — is **UNSUPPORTED.** It is not a documentation
gap: the required-extension materialize boot phase is fail-closed in production
and reads its seed from an **image-baked path with no environment or
configuration override on the production boot path**, so a bare host checkout
aborts at boot by design (see below). The CLI's
`install --mode prod` provisions an instance but neither builds nor establishes
a runnable production runtime; that partial state is a byproduct, not a
supported target.

## The supported production lifecycle (name it)

1. A `v*` tag triggers **`.github/workflows/build-image.yml`**, the SOLE
   builder/publisher of the canonical runtime image. Its release-publish job
   pushes to **`ghcr.io/cinatra-ai/cinatra`** (`images: ghcr.io/${{ github.repository }}`).
2. **`.github/workflows/dockerhub-publish.yml`** then mirrors that GHCR release
   to the public **`docker.io/cinatra/cinatra`** repo — a multi-arch-preserving
   `docker buildx imagetools create` manifest copy, so a `docker pull
   cinatra/cinatra:<version>` works with no GHCR login. It NEVER builds.
3. Operators `docker pull cinatra/cinatra:<version>` and `docker run` / deploy
   (the cinatra-ai/ops `deploy-instance.sh` compose flow). The container runs
   `node server.js` on Next's standalone output.

## Why the image, and only the image (grounded against cinatra@main)

The `Dockerfile` build stage performs work a host checkout does **not**, all of
which the production runtime depends on:

- **Required-set acquisition.** `cinatra extensions acquire-prod` materializes
  the SHA-pinned required set into `/app/extensions`.
- **Required-extension OAS seed.** `scripts/extensions/build-required-oas-seed.mjs
  --source /app/extensions --out /app/.cinatra-required-oas-seed` projects the
  image-owned seed. `materializeRequiredExtensions()` accepts a **programmatic**
  `seedDir` option, but the seed source path defaults to the hardcoded
  `DEFAULT_REQUIRED_OAS_SEED_DIR = "/app/.cinatra-required-oas-seed"`
  (`src/lib/required-extension-materialize.ts`), and the boot phase
  (`src/lib/boot/phases/required-extension-materialize.ts`) passes **no
  override** — no env or config knob overrides it on the production boot path,
  so the running instance always uses that default. In production that phase is
  **fail-closed**: a missing/unreadable seed at that path aborts the boot. A
  bare host checkout has no seed there, so it cannot boot in production.
- **Presence-aware map regeneration.** `scripts/extensions/generate-extension-manifest.mjs`
  (+ `--check --self`) regenerates the committed `src/lib/generated/*` barrels
  against the acquired set. Those committed barrels carry literal dynamic
  `import()` specifiers for the **full** extension universe; a host `next build`
  fails when the bundler resolves un-acquired packages (the fresh-clone
  module-resolution class — cinatra#109 / cinatra#110; the host-build
  consequence is cinatra-ai/cinatra-cli#145).
- **Standalone assembly.** `next.config.ts` sets `output: "standalone"`, and
  the runtime stage copies `.next/standalone` + `.next/static` + `public` + the
  seed + the materialized CLI into place. Running standalone on a host means
  replicating that copy dance by hand.

The prod-boot e2e (`scripts/ci/prod-boot-e2e.sh`) proves exactly one contract:
*"the production image is bootable from its own inputs,"* materializing the
required set *"from the image's required-OAS seed, **never from a standalone
install-dir knob**"* (the former `CINATRA_AGENT_INSTALL_DIR` knob and the
`agent_install_path` DB metadata were deliberately **deleted**). No host-prod
boot test exists, so no host-prod boot contract is currently verified.

## `CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE=true` is NOT a workaround

That flag disables a required-set **safety invariant**. The materialize phase
fails closed precisely so a production boot cannot come up "healthy" while
WayFlow's `:/agents:ro` mount and the host scan point at an empty or stale
agent tree (the in-process required-activation assert checks the registry, not
the filesystem, so it would still pass). Setting the flag `true` to force a
host checkout to boot **removes that guarantee** and can leave a **degraded**
instance serving traffic (the phase reports itself skipped rather than
materializing the tree).

It is **not a default** and it is **not a sanctioned host-prod escape hatch.**
Its only use in this repository is a build/CI context that never serves
production traffic — `.github/workflows/design-visual-verify.yml`, which boots
the app solely to screenshot the design surface. This decision does not
sanction it for production; any use to make a production host checkout "work"
is out of contract.

## What this unblocks (pinned so S3/S5 need not re-litigate)

**First, the released-vs-local pin (resolve one ambiguity up front):** the
supported production artifact is a **pinned, PUBLISHED image** —
`ghcr.io/cinatra-ai/cinatra` or the public mirror
`docker.io/cinatra/cinatra`, referenced by a `v*` version tag or an immutable
digest. A locally built image is **not** presented as the supported production
artifact; the supported target is the published tag/digest, whose contents are
pinned by the SHA-pinned required-extension lock and CI, not by a host's
main-tip clone.

- **cli#145 (S3 — presence-aware host prod build):** because host prod is
  unsupported, **close it as superseded** — do **not** deliver a host
  `next build` (nor a CLI-owned host build command that presents a locally
  built image as the supported production artifact). The presence-aware map
  regeneration is an **image-build** concern and stays owned by the `Dockerfile`
  pipeline. If S5 needs a "get me a runnable prod image" affordance, it is a
  `docker pull` of the pinned published tag/digest, not a host build.
- **cli#146 (S5 — post-install run guidance):** conditional on this ruling,
  make the prod-install output image-lifecycle-aware with these acceptance
  criteria:
  - the prod completion hint **does not print `pnpm dev`**; it prints a
    concrete supported entry point — `docker pull cinatra/cinatra:<version>`
    (pinned tag/digest) and the run/deploy step — routed through the
    established cinatra-ai/ops Compose lifecycle (`deploy-instance.sh`), not a
    bare `docker run` (a bare `docker run` is not actionable on its own: the
    supported runtime needs the platform services, env, mounted volumes, and
    persistence the ops compose flow wires up);
  - `cinatra instance start` (the dev `pnpm dev` lifecycle) invoked against a
    `CINATRA_RUNTIME_MODE=production` checkout **detects prod mode, exits
    nonzero, and prints that same guidance** (or routes to the image
    lifecycle) rather than silently launching dev;
  - dev-mode install/`instance start` behavior is **unchanged**;
  - tests cover all three (prod hint, prod-checkout refusal, dev unchanged).

## If host-prod is ever adopted (explicitly out of scope here)

Should a future, owner-approved decision reverse this and make host prod a
supported target, the concrete, **tested** work it requires — none of which
exists today, and which is therefore a code change, not a docs edit — is:

- an env-overridable seed directory replacing the hardcoded
  `DEFAULT_REQUIRED_OAS_SEED_DIR`, threaded through the boot phase
  (`src/lib/required-extension-materialize.ts`,
  `src/lib/boot/phases/required-extension-materialize.ts`);
- a checkout-local seed build step mirroring
  `scripts/extensions/build-required-oas-seed.mjs`;
- the presence-aware map regeneration on the host (cli#145);
- the standalone `.next/static` + `public` copy assembly;
- a writable durable data root (`CINATRA_EXTENSION_DATA_ROOT` /
  `resolveExtensionDataRoot`, already env-overridable, default
  `/data/extensions`) with **tested restart persistence**;
- and documenting all of the above in `.env.example`.

## Scope of THIS decision

**Docs + decision only. No runtime code changes.** `.env.example` is
intentionally left unchanged: documenting host-prod runtime knobs there would
imply a host-prod contract this decision declines to create. The relevant
existing data-root override — `CINATRA_EXTENSION_DATA_ROOT`
(`src/lib/extension-data-root.ts`), which the deploy already sets on the
image — is not listed in `.env.example` today and needs nothing from this
ruling; it is a deploy-managed override, not a host-dev knob.
