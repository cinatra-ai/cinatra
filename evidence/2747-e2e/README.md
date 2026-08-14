# cinatra#2747 — install round-trip evidence (production-equivalent boot)

Real install round-trip on the primary workstation, through the marketplace
path, on a `next build` + `next start` boot. The lane created and fully removed
its own docker compose project.

## Run record

| Item | Value |
|---|---|
| Branch / head | `fix/2747-package-store-runtime-deps` @ `df2021414` |
| Build class | production-equivalent — `pnpm build` (Next, Turbopack) then `pnpm start`. No dev server. |
| Next BUILD_ID | `rzlTE4g-OW_0s8NhY5XY4` |
| Host | primary macOS workstation (Darwin 25.5.0, arm64), node v24.18.0 via nvm |
| Compose project | `p2747` (created by this lane, fully removed at teardown) |
| Services | `p2747-postgres-1` (127.0.0.1:5434), `p2747-redis-1` (6379), `p2747-nango-db-1` (5435), `p2747-nango-server-1` (3003/3009), `p2747-verdaccio-1` (4873), `p2747-neo4j-1`, `p2747-graphiti-1`, plus a lane `p2747-redis-6579` |
| App URL | http://localhost:3087 (port matches the workstation's `BETTER_AUTH_URL`, so the browser origin check passes) |
| Account | first account through the normal sign-up API → platform admin |
| Namespace | provisioned through `/setup/name` (local provisioning only; no vendor registration, no outward action) |
| Env toggles | `CINATRA_E2E_SETUP_BYPASS=true`, lane `SUPABASE_DB_URL`, `BULLMQ_QUEUE_NAME=p2747-lane`, `CINATRA_EXTENSION_DATA_ROOT=<lane>/data/extensions`, `CINATRA_ENCRYPTION_KEY` (lane-local, generated, never printed, never committed), `CINATRA_BOOT_READY_TIMEOUT_MS` |

Nothing was published, released, tagged, or deployed outward. The only publish
was to the lane's own loopback Verdaccio container (`127.0.0.1:4873`), which the
lane created and destroyed — the same registry `cinatra instance setup dev`
seeds by itself.

## Where the tarballs actually come from

`[marketplace-install] ... GET http://127.0.0.1:4873/@cinatra-ai%2f...` — the
marketplace install resolves the tarball from the instance's registry, which on
a dev/lane instance is the LOCAL Verdaccio seeded by `cinatra instance setup
dev`. That seed publishes the extension SOURCE tree verbatim, so every seeded
package declares its runtime `dependencies` with nothing bundled beside them.
That is the shape the S4 run installed.

## BEFORE — the defect, reproduced verbatim

`Install now` on **MCP Servers** (`@cinatra-ai/mcp-server-connector@0.1.1`, the
issue's own control), UI toast `Couldn't install … (Ref: REF-C77F091E)`, server:

```
[marketplace-install] install failed for @cinatra-ai/mcp-server-connector (category=unrecoverable):
  … (pipeline-threw:[package-store] @cinatra-ai/mcp-server-connector: runtime dependencies are
  neither bundled in the tarball nor covered by a signed materialization plan (server-only, zod). …)
```

The lane registry's packument for that version:
`deps={"server-only":"0.0.1","zod":"^4.4.3"}`, `files=["src","!src/__tests__","cinatra"]`,
`serverEntry="./register"` — the raw source shape.

Screenshots: `E1` (marketplace, Install enabled), `E2` (inline install form),
`E3` (the catch-all failure toast).

## AFTER — the appointment connector at current head installs

`@cinatra-ai/google-appointment-schedules-connector` at repo head `6828702`
(the sha the S4 dev-lock pinned; its manifest declares `dependencies:
{"server-only": "^0.0.1"}`), built with the FIXED
`scripts/extensions/build-server-entry.mjs`:

```
{ "mode": "bundled", "dependencyMode": "inline",
  "prunedDependencies": ["server-only"], "declaredDependencies": ["server-only"] }
```

Published to the lane registry, then installed through `/configuration/marketplace`
→ Install now. The packument the installer read:
`deps=null`, `serverEntry="./register.mjs"`, `files=[…,"register.mjs"]`.

Result — the integrity gate is cleared and the install is committed:

* runtime store dir materialized with its sidecar:
  `data/extensions/connector/@cinatra-ai/google-appointment-schedules-connector/395024fefd…/`
  (`package.json` → `dependencies: null`, `cinatra.serverEntry: "./register.mjs"`);
* `cinatra.installed_extension` → `0.1.0 | active | organization | source.type="verdaccio"`
  with the real `integrity` + `contentHash`;
* `cinatra.extension_install_ops` → phase `finalized`, digest `395024fefd…`.

Screenshots: `E4`, `E5`. Raw rows: `installed-extension-rows.txt`. Pipeline
lines: `install-pipeline.log`.

## Honest residuals (NOT cinatra#2747)

1. **Hot activation is refused for a loopback registry.** After the pipeline
   finalized, the loader logged
   `registry 127.0.0.1:4873 is not a trusted activation host (registry.cinatra.ai)`,
   so the connector did not import in-process and does not render in
   `/connectors`. That is the activation-trust control (`trustedActivationHosts`
   + signature policy), a different contract from the bundled-deps gate. The
   install itself stayed committed, exactly as the pipeline message states.
2. **The dev local-registry seed is the second offender.** It lives in the
   `cinatra-cli` repo (`src/seed-local-registry.mjs` — it `npm pack`s the source
   dir), outside this branch. Until it packs the builder's pack dir instead, every
   dev/lane instance keeps serving source-shaped tarballs.
3. The catch-all toast (the error text never reaching the UI) is the separately
   filed defect the issue names; it is untouched here.
