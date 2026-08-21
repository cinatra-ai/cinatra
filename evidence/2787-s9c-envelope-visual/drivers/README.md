# The capture path, so this evidence is reproducible

These are the drivers behind the S9c host cells. They are evidence tooling, not
application code: nothing here ships, and nothing here writes a lifecycle row by
hand. Every row the cards draw is written by the SHIPPED writers, reached either
through the app's own surfaces or through the dev lifecycle-seed route (which
contains no SQL and refuses to seed a card the named actor could not open).

## The stack the round used

Lane-private, and the operator's stack is never referenced:

| Fact | Value |
|---|---|
| Compose project | `s9c2795w` — own Postgres (`127.0.0.1:55473`), own Redis (`127.0.0.1:56409`), own volumes, own network |
| App | dev runtime on port **3072**, queue `cinatra-s9c2795w-jobs` |
| Host page | a plain static server on port **5573** serving `site-widget-host-page.html` |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` |
| LLM | none — `CINATRA_TEST_LLM_PROVIDER=scripted` |
| Fresh DB | `scripts/apply-public-schema.mjs`, then `pnpm auth:migrate` (NOT `db:migrate`) |

Two things the dev runtime needs before it will boot, both learned the hard way:

1. **Stage the required extension closure first.** A bare `pnpm install` in a new
   worktree leaves `extensions/cinatra-ai/` empty and the app dies with ~200
   `Module not found` errors for `@cinatra-ai/*-connector`. Stage the closure
   pinned by `cinatra-required-extensions.lock.json` +
   `cinatra-dev-extensions.lock.json` (120 packages) into `extensions/`.
2. **Then install again.** The staged connectors are workspace members
   (`extensions/cinatra-ai/*-connector` in `pnpm-workspace.yaml`), so their own
   dependencies — `@nangohq/frontend`, `resend` — only resolve after a second
   `pnpm install`. Restore `pnpm-lock.yaml` afterwards; an evidence round must not
   change it.

## The order

```
# 1. the instance owner, through the REAL first-owner sign-up surface
node evidence/2787-s9c-envelope-visual/drivers/01-signup.mjs http://localhost:3072 <outDir>

# 2. the widget instance + its connect-site, via the SHIPPED writers
S9C_ORG_ID=<org> S9C_ADMIN_USER_ID=<user> \
  node --conditions=react-server --env-file=.env.local --import tsx \
  evidence/2787-s9c-envelope-visual/drivers/02-seed-widget-site.mts http://localhost:5573 s9c-local-site

# 3. a real pending review gate for that actor
S9C_ORG_ID=<org> S9C_ADMIN_USER_ID=<user> \
  node --conditions=react-server --env-file=.env.local --import tsx \
  evidence/2787-s9c-envelope-visual/drivers/04-seed-review-gate.mts http://localhost:3072

# 4. the site_widget cell
node evidence/2787-s9c-envelope-visual/drivers/05-capture-site-widget.mjs \
  "http://localhost:5573/site-widget-host-page.html?cinatra=http://localhost:3072&assistant=wordpress&instanceId=s9c-local-site" \
  <outDir>
```

`--conditions=react-server` is required for anything importing a `server-only`
module; without it the import throws before the script runs.

## What each file is

- `01-signup.mjs` — creates the instance owner through the real
  `/setup/account` form and saves the session.
- `02-seed-widget-site.mts` — registers the widget instance and mints the
  connect-site, then asserts `deriveFrameBinding` closes. Writes only through
  `writeConnectorConfigToDatabase` and `upsertConnectSiteAndMintCredential`.
- `03-probe-widget-frame.mjs` — read-only probe: does the embed boot inside a
  plain page and does the bridge handshake close?
- `04-seed-review-gate.mts` — seeds the run row (the sanctioned e2e harness
  bypass) and calls `POST /api/development/lifecycle-seed`, whose shipped writers
  create the gate, the repair, the successor gate and the verification record.
- `05-capture-site-widget.mjs` — the cell itself: signs the frame in through the
  hosted PKCE popup, sends one turn, then records anchors + wire for pending and
  settled.
- `06-diagnose-capabilities.mjs` — the diagnostic that found the
  `origin_unconfigured` refusal, by capturing the exact headers the frame sent.
- `site-widget-host-page.html` — the plain page standing in for the CMS page.

## Two traps inside the capture, both real

- **The frame re-announces `READY` after its own sign-in.** The host page must
  answer EVERY announcement with a fresh `correlationId` and the next `seq`, or
  the frame sits in "Waiting for the host…" forever. Answering only the first one
  is the bug that makes a signed-in widget look broken.
- **The connector's `requiredInstanceFields`.** The `cit_` consume refuses with
  `origin_unconfigured` unless the instance row carries `id`, `name`, `username`
  and `applicationPassword`. The two credential fields are what the connector
  would use to call a WordPress REST API; this capture never calls one, so they
  are present-but-inert placeholders and nothing on the lifecycle path reads them.

The driver also removes the dev runtime's `<nextjs-portal>` overlay before
clicking and before every shot. That overlay is dev-server furniture which
swallows pointer events and covers the surface; removing it changes no
application behaviour.
