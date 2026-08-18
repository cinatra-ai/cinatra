# Two-version install proof — how to run it

`PROOF-STATUS.md` says what this proof establishes. This file says how to
reproduce it. Everything here is throwaway and lane-private: its own Compose
project, its own ports, its own volumes, its own queue name. It starts nothing
that already exists on the machine and writes nothing outside the worktree.

No production credential is involved at any point. The signing key is generated
per run, and the registry is anonymous on the loopback interface.

## Ports

| Service | Port |
|---|---|
| Postgres | `127.0.0.1:55440` |
| Redis | `127.0.0.1:56390` |
| Verdaccio (the package registry) | `127.0.0.1:4880` |
| Lane storefront (the browse catalog) | `127.0.0.1:4881` |
| The application | `127.0.0.1:3477` |

## Sequence

```bash
cd <worktree>
D=evidence/2762-two-version-lane/drivers

# 1. The stack. Its own project name, so nothing else is touched.
docker compose -p x2774evproof -f $D/lane-stack.compose.yml up -d

# 2. A signing key for this run. The PUBLIC half goes in the app env below;
#    the private half never leaves the run.
node -e 'const{generateKeyPairSync}=require("crypto");const{publicKey,privateKey}=
generateKeyPairSync("ed25519");console.log(JSON.stringify({
 pub:publicKey.export({format:"der",type:"spki"}).toString("base64"),
 priv:privateKey.export({format:"der",type:"pkcs8"}).toString("base64")}))' > /tmp/lane-key.json

# 3. The app env. See "Environment" below; write it to .env.local in the
#    worktree. It is gitignored and is removed at teardown.

# 4. A fresh database. Better Auth's public tables, then its migration.
#    The cinatra store schema is created by boot itself — do not run it by hand.
node --env-file=.env.local scripts/apply-public-schema.mjs
pnpm auth:migrate

# 5. Publish. The dependency first (the install threads the declared closure),
#    then the version signed with an UNTRUSTED key for the negative run, then
#    the version signed with the TRUSTED key.
#
#    LANE_MANIFEST_MARK=true stamps the connector's own declared `calendarId`
#    placeholder with the version being published, so the setup surface NAMES
#    the manifest that reached the render. Without it a published version that
#    is byte-identical to the bundled one renders identical pixels, and no
#    screenshot of that surface can say which version served. See PROOF-STATUS.
GOOD=$(node -e 'console.log(require("/tmp/lane-key.json").priv)')
node $D/publish-signed.mjs extensions/cinatra-ai/google-calendar-connector 0.1.3 http://127.0.0.1:4880 "$GOOD"
LANE_MANIFEST_MARK=true node $D/publish-signed.mjs extensions/cinatra-ai/google-appointment-schedules-connector 0.1.1 http://127.0.0.1:4880 "<an untrusted key>"
LANE_MANIFEST_MARK=true node $D/publish-signed.mjs extensions/cinatra-ai/google-appointment-schedules-connector 0.1.2 http://127.0.0.1:4880 "$GOOD"

# 6. The storefront, listing whichever version the next step should install.
LANE_LISTED_VERSION=0.1.1 node $D/lane-storefront.mjs &   # the negative run
# LANE_LISTED_VERSION=0.1.2 …                             # the real install

# 7. The application, and an operator to drive it with.
pnpm dev &
node $D/lane-admin-session.mjs http://127.0.0.1:3477 \
  postgresql://cinatra:cinatra@127.0.0.1:55440/cinatra <email> <password>

# 8. The proof itself. Modes: baseline | negative | install | assert.
#
#    The two trailing arguments are separate on purpose:
#      <expectVersion>        the version the SETTINGS surface must name
#      <expectServingVersion> the version whose MANIFEST must have produced the
#                             setup render
#    They differ exactly when a newer row is present but has not activated —
#    settings names the newer row while the bundled manifest still serves. That
#    is #2762 acceptance item 1, and keeping the two apart is what lets one run
#    assert it.
OUT=$PWD/evidence/2762-two-version-lane/screenshots
node $D/lane-proof-driver.mjs baseline http://127.0.0.1:3477 <email> <password> $OUT baseline 0.1.0 0.1.0
node $D/lane-proof-driver.mjs negative http://127.0.0.1:3477 <email> <password> $OUT negative
node $D/lane-proof-driver.mjs assert   http://127.0.0.1:3477 <email> <password> $OUT after-refusal 0.1.0 0.1.0
# switch the storefront to LANE_LISTED_VERSION=0.1.2, then:
node $D/lane-proof-driver.mjs install  http://127.0.0.1:3477 <email> <password> $OUT install
node $D/lane-proof-driver.mjs assert   http://127.0.0.1:3477 <email> <password> $OUT post-install 0.1.2 0.1.2
# restart the app, then:
node $D/lane-proof-driver.mjs assert   http://127.0.0.1:3477 <email> <password> $OUT after-restart 0.1.2 0.1.2

# 9. The stranded-row fixture, written BEFORE a boot.
docker exec -i x2774evproof-postgres-1 psql -U cinatra -d cinatra < $D/stranded-row-fixture.sql
# restart the app and read the boot log for StrandedInstallReconcile.

# 10. Teardown.
docker compose -p x2774evproof -f $D/lane-stack.compose.yml down -v
rm -f .env.local $D/.lane-run.env
rm -rf .lane-data
```

## Environment

The lane-specific keys, beyond the ordinary local development set (database,
Redis, Better Auth secret, encryption key, and a `BULLMQ_QUEUE_NAME` unique to
this lane so it never shares a queue with another dev server):

| Key | Value | Why |
|---|---|---|
| `MARKETPLACE_BASE_URL` | `http://127.0.0.1:4881` | The browse catalog. Honored only outside `NODE_ENV=production`. |
| `CINATRA_AGENT_REGISTRY_URL` / `_TOKEN` | the lane registry | Makes the Install affordance live so it actually dispatches. |
| `CINATRA_GATEKEPT_INSTALL` | `false` | Pins the direct registry-read install path. |
| `CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL` | `http://127.0.0.1:4880` | The **only** source of the trusted activation hosts. |
| `CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN` | any non-empty | Required with the URL — the public triple is all-or-none. |
| `CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE` | `scope-based` | The third of the triple. |
| `CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS` | the run's public key | The trust root for the signature. |
| `CINATRA_EXTENSION_DATA_ROOT` | a lane-local directory | The default is not writable on this platform. |
| `CINATRA_E2E_SETUP_BYPASS` | `true` | **Disclosed:** skips the setup wizard gate only. It grants no authentication and changes nothing in the install, resolution or reconciliation paths under test. |

## Why the publisher builds the package

`publish-signed.mjs` does more than pack the working tree, because the runtime
store refuses a package that is not in publishable shape, and both refusals are
correct:

- **Built ESM only.** The in-tree form points its export map at TypeScript
  source, since inside the monorepo the host compiles the package. The store
  accepts built artifacts only, so `build-publishable.mjs` bundles each export
  to ESM and repoints the map. Host SDK peers stay external — a second copy
  would break ABI identity.
- **Runtime dependencies shipped, not resolved.** The installer never runs a
  package manager, by design, so every runtime dependency must travel in the
  tarball. The publisher copies each one into the staged `node_modules` and
  names it in `bundleDependencies`.
- One detail worth knowing: the `server-only` import is a build-time guard whose
  module throws when loaded outside a server condition, so the build drops the
  import while the package stays declared and bundled. A real publisher's build
  does the same.

## Files

| File | What it is |
|---|---|
| `drivers/lane-stack.compose.yml` | The throwaway stack. |
| `drivers/verdaccio-config.yaml` | Registry config: no upstream, anonymous, loopback only. |
| `drivers/publish-signed.mjs` | Build, pack, sign, publish. |
| `drivers/build-publishable.mjs` | In-tree source → publishable built ESM. |
| `drivers/lane-storefront.mjs` | The anonymous browse catalog. |
| `drivers/lane-admin-session.mjs` | An operator with admin standing and an active organization. |
| `drivers/lane-proof-driver.mjs` | The browser proof: four modes, screenshots, assertions. |
| `drivers/provider-write-resolution.mts` | The provider-write seam's own row selection. |
| `drivers/stranded-row-fixture.sql` | The pre-existing stranded install row. |
| `drivers/verify-signature-and-trust.mts` | The trust verdict over the published package. |
| `logs/*.txt` | Captured output. |
| `screenshots/*.png` | The screens the assertions were read from. |
