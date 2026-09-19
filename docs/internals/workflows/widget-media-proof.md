# Widget media and screenshot fixtures (#3459)

These development tools supply the two prerequisites for the remaining #3091
display checks: a CMS that really connects to the application, and a producer
that captures and files screenshot bytes with measured facts. They do not mark
the media display matrix as passed.

## Prepare an isolated application

Use Node 24, pinned extension sources and the normal workspace installation.
Give the application its own database, queue name, extension-data directory and
connection service. When cloning a capture database, run the normal
`cinatra instance db migrate` command before booting: an older template may lack
columns that current boot code already expects.

The database also needs an instance identity. The token exchange consumes a
valid code but returns `invalid_grant` if that identity is absent. Provision it
through the existing command before connecting:

```sh
pnpm provision:dev-instance --namespace widget-proof --display-name 'Widget Proof' </dev/null
```

For this surface test the existing `CINATRA_E2E_SETUP_BYPASS=true` option can
suppress unrelated setup-wizard redirects. It does not authenticate a browser
or grant permission to approve a connection. Sign in normally as a fixture
administrator and keep browser storage state private (0600). An admin session
and a successful site connection are different prerequisites.

## Connect a real WordPress site

Use a fresh `wordpress-plugin` checkout and the existing
`cinatra-wordpress-dev:6.9-php8.3` image. Record the plugin commit with the proof.
The mounted plugin and fixture PHP sources must be readable by the container's
web-server user; a private 0700/0600 source extraction lets root activate the
plugin but makes its settings page return 403 to the browser.

Create a private environment file containing randomly generated
`WIDGET_DB_PASSWORD`, `WIDGET_DB_ROOT_PASSWORD` and `WIDGET_WP_PASSWORD`, plus:

```sh
WIDGET_WP_PLUGIN_PATH=/absolute/path/to/wordpress-plugin
WIDGET_WP_ORIGIN=http://localhost:8087
WIDGET_WP_PORT=8087
WIDGET_APP_SERVER_URL=http://host.docker.internal:3007
```

`WIDGET_APP_SERVER_URL` is the **container-reachable** application address used
by PHP for `/api/connect/token`. The browser's application origin stays the
one configured in the app. On a rootless Docker host, use its existing private
relay and set `WIDGET_HOST_GATEWAY` to that relay address. Prove reachability
from the container before starting the ceremony.

```sh
docker compose --env-file /private/path/widget.env -p widget-proof \
  -f scripts/fixtures/widget-wordpress.compose.yml up -d

CINATRA_RUNTIME_MODE=development node --env-file=/private/path/widget.env \
  --import tsx scripts/fixtures/connect-wordpress.mts \
  --app http://localhost:3007 --wordpress http://localhost:8087 \
  --connector-instance WORDPRESS_CONNECTOR_INSTANCE_ID \
  --storage-state /private/path/browser-state.json \
  --evidence /outside-the-product-tree/site-connection.json
```

Run the browser beside its fixture password and authenticated state. The
driver submits the plugin's nonce-protected form, checks the PKCE destination,
approves the connection and waits for the CMS success notice emitted after
the actual server-side token exchange. It never reads or seeds a connection
credential. Its evidence explicitly leaves frame authorization and per-kind
media rendering unchecked; connection success alone cannot pass those cells.
The driver waits for the consent form to hydrate before approving: a native
pre-hydration POST under the consent page's `no-referrer` policy has an opaque
origin and is refused by the Server Actions origin check.

Register this WordPress site through Cinatra's WordPress MCP connector setup
first, using a real WordPress application password. Copy its **connector
instance ID** into `--connector-instance`. The plugin's connection response
currently fills that field with the Cinatra installation identity; the frame
requires the WordPress connector instance instead. The driver saves the right
selection through the CMS settings form after the exchange. The registered
instance's site origin must match the CMS origin exactly.

Verify frame-owned authentication separately, using the state the connection
driver saved:

```sh
CINATRA_RUNTIME_MODE=development node --import tsx scripts/fixtures/verify-wordpress-widget.mts \
  --wordpress http://localhost:8087 --storage-state /private/path/browser-state.json \
  --evidence /outside-the-product-tree/widget-frame.json
```

This waits for the real CMS mount, the frame's own sign-in popup, the active
assistant and its composer. Warm the app's frame routes before a cold dev boot's
first popup, as the existing widget UAT setup does. An `instance_unresolved`
audit means the connector registration/selection is missing; it is not repaired
by reissuing a site credential. Refresh the first-party app session normally if
the popup presents a sign-in screen.

If Docker's automatic subnet pool is exhausted, use a separately checked,
non-overlapping subnet for this project, or attach only this fixture to its
own application's existing network through a Compose override. If the host
cannot create a container, record the actual capacity error before retrying;
repeated application rebuilds do not repair host resource limits.

## File a measured screenshot

The producer requires a completed real run in the target organization whose executed
package declares `@cinatra-ai/screenshot-artifact` in `cinatra.produces`, with
the corresponding required artifact dependency. The pinned package must also
be resolvable by the canonical producer-assertion reader. An installed-looking
template without its package is refused before a browser opens.

The private fixture at `tests/fixtures/screenshot-producer-agent` supplies a
deterministic run without a model call. Stage its `codex-widget-proof` directory
under the lane's `extensions/`, and mount the same fixture root read-only into
the lane's normal WayFlow runtime. Restart the development app to compile it.
Use that lane's own `WAYFLOW_BASE_URL`, bridge and context keys. Never publish
the fixture to an external registry.

For the canonical manifest read, `serve-screenshot-package.mjs` exposes exactly
that committed fixture and its integrity-checked tarball on loopback. It has no
write endpoint. Start it with `CINATRA_RUNTIME_MODE=development`, and use
`CINATRA_AGENT_REGISTRY_URL=http://127.0.0.1:4877` and
`CINATRA_AGENT_REGISTRY_SCOPE=@codex-widget-proof` **only in the isolated lane**.
It is a test package source, not proof of marketplace installation.

```sh
node --env-file=.env.local --import tsx scripts/fixtures/seed-screenshot-run.mts \
  --org ORGANIZATION_ID --user FIXTURE_ADMIN_USER_ID --url http://localhost:8087/
```

This uses the existing end-to-end fixture boundary: it seeds only run creation
and enqueues the real worker. The worker and WayFlow perform execution; the
command waits for the stored result and never writes a completed status. Use
the returned run ID below. The capture is then performed by this development
command and attached to that run; the no-model flow itself does not take pixels.

```sh
node --env-file=.env.local scripts/fixtures/capture-screenshot.mjs \
  --org ORGANIZATION_ID --run RUN_ID --output capture-light \
  --url http://localhost:8087/ --ready 'main h1' \
  --title 'WordPress screenshot' --palette light --width 1440 --height 1000
```

Use `--storage-state /private/path/browser-state.json` for an authenticated
target. Choose a readiness selector belonging to the intended content. The
producer waits for that content and fonts, captures a viewport PNG, and derives
`capturedUrl`, `viewport` and `capturedAt` from that operation. A navigation or
resize during capture refuses the write. Metadata cannot be supplied by CLI.

The existing writer validates the installed type and organization, stores the
binary representation and typed facts, and finalizes the run ledger in the same
transaction. Project ownership follows the run. Re-driving identical bytes for
the same output returns the existing artifact; its original stored facts are
not overwritten or misreported as the latest capture's facts.

The standalone command uses the workspace's SSR loader so real host modules
retain their path aliases and async initialization. Only the `server-only`
bundler marker is consumed; file-relative CommonJS globals are supplied for host
modules that normally receive them from Next. Database, registry and artifact
modules are real. The registry client also handles pacote's native Node ESM
default export, where its computed CommonJS methods are exposed.
All fixture entry points require an explicit development runtime.

The artifact page carries the authorized live object record through the bounded
object-content projection when a file has no text projection. That lets the
screenshot display read the recorded capture facts beside the actual PNG. The
projection explicitly says `source: "live"` and names no snapshot revision.
Historical review readers do not receive this live record; this page wiring does
not claim to supply immutable capture facts for a pinned review.

## Validation and remaining acceptance

```sh
pnpm exec vitest run src/lib/__tests__/dev-screenshot-producer.test.ts
pnpm exec vitest run src/lib/__tests__/dev-screenshot-fixture.test.ts
node --import tsx --test scripts/fixtures/__tests__/screenshot-capture.test.ts
```

The browser test verifies actual PNG dimensions and redirected-page facts.
Writer tests cover binary preservation, transactional finalization, organization
boundaries, missing producer declarations, unavailable pinned manifests,
extension write denial and concurrent retries. They are not real-page acceptance
evidence.

After connecting and producing the fixture, #3459 still requires the actual
widget frame authorization, all six media kinds and the CMS picture pair
through the byte capability, card/page and matched-upload cases for the two new
displays, embedded deck rendering, and no blank widget displays. Capture both
palettes through product navigation, attest the actual run IDs and grade against
design main. Capture screenshots in the organisation's working area outside
every repository. Retained proof belongs only in the designated proof repository,
with the owner's visibility restrictions applied. Never commit proof media or
run-evidence bundles to any branch of this product repository. Do not close #3459
based only on the two prerequisite tools.
