# Provision a development instance in one command

Audience: people developing Cinatra itself. This is not product or
administration documentation.

## What it is for

Proving a change on a development instance normally begins with a browser
session through the setup wizard: pick a namespace, pick a model provider and
type in its key, fill in the connector-service secret, set the public origin the
model provider calls back to — then restart, because that origin is read once,
at startup. Each of those steps takes a browser and a person; the underlying
writes take seconds.

`pnpm provision:dev-instance` performs the same four writes in one call, through
the **same writers** the four screens use. It writes no row shape of its own and
seals nothing with a codec of its own.

## Running it

```
echo '{"providerApiKey":"…","connectorServiceSecretKey":"…"}' \
  | pnpm provision:dev-instance -- \
      --namespace acme-dev \
      --display-name "Acme Development" \
      --provider anthropic \
      --public-origin https://acme.example
```

Every argument is optional; a leg you leave out is a leg the command does not
touch. `--provider` accepts `openai` or `anthropic`.

## How secrets travel

Secret values reach the running process **over stdin**, as a small JSON
document. They are:

- never a command-line argument — the parser has no flag that could carry one,
  and refuses a secret-looking flag rather than ignoring it (an ignored
  `--api-key` is still a key in the shell history and in `ps`);
- never written to an environment file on disk;
- never logged — the command reports only whether a secret was supplied.

Recognised keys: `providerApiKey`, `providerProjectId`,
`providerOrganizationId`, `connectorServiceSecretKey`, `connectorServiceUrl`.

Each value is sealed by the exact encryption call the corresponding screen
already uses before anything is persisted.

## The runtime gate

The command refuses to run outside a development runtime, and so does each write
it performs — independently, one gate per wrapper, using the same predicate the
rest of the codebase uses (`isAppDevelopmentMode()` / `getAppRuntimeMode()`,
reading `CINATRA_RUNTIME_MODE` / `APP_RUNTIME_MODE`). This is in addition to,
never instead of, the admin-session authorization the wizard's own actions
require.

That predicate reads an **unset** mode as development, as it does everywhere
else in the codebase. "Nobody declared a mode" is not the same claim as "this is
a development instance", though, so the gate adds one condition of its own: an
undeclared runtime mode under `NODE_ENV=production` is refused as the ambiguity
it is. A declared `CINATRA_RUNTIME_MODE=development` still passes under a
production build — running one locally is exactly who this command is for.

## Which writer each leg reuses

| Leg | Screen | Writer reused |
| --- | --- | --- |
| Namespace | `/setup/name` | the action's own deferred persistence path (`persistDeferredInstanceIdentity`) |
| Connector-service secret | `/setup/secrets` | the host connector-config writer the connector's store is bound to, with the connector's preserve-on-blank merge |
| Provider connection (`openai`) | `/setup/model` | the boot-time environment bootstrap, as-is — the key is handed to it in memory |
| Provider connection (`anthropic`) | `/setup/model` | the wizard's full sequence: consent transaction, native-MCP-mode switch, readiness saga, fenced commit |
| Public origin | `/configuration/development` | `setMcpPublicBaseUrl` / `buildMcpPublicBaseUrlRow` |

Anthropic is not a smaller version of the OpenAI road. Its arm also records the
skills-upload consent and switches native MCP mode, and the setup step only
reads ready once the readiness saga and that opt-in both stand — so the command
drives all of it, or `deriveSetupAiStepState` reads not-ready no matter how good
the key is.

## The restart step

The public-origin write leaves the OAuth audience allowlist stale until the app
restarts: the allowlist is snapshotted once, at plugin construction. Until then
a token request naming the **new** origin is rejected outright, and the
**previous** origin stays accepted — so clearing the field is not, on its own, a
revocation. The command prints the restart step rather than leaving that to the
next failed token request.

## Idempotency

Running the command twice with the same input performs no additional database
write and makes no additional external call. Each leg reports whether it wrote.

## Tests

- unit tier (`pnpm test:root`): the runtime gate, the shape claim that every
  wrapper gates itself, and the argument surface (no secret-bearing flag).
- real-database tier: `SUPABASE_DB_URL='…' pnpm test:dev-instance-provisioning`
  — row equality against the screens' own writers, the refusal with zero writes,
  the composed run, and idempotency. Two prerequisites: a reachable development
  Postgres, and the development extensions materialised
  (`node scripts/ci/sync-dev-extensions.mjs --pinned`), because the
  connector-secret row equality is asserted against the connector's own
  `saveNangoSettings` — the same way the tracked connector action-gate suites
  read those sources.
