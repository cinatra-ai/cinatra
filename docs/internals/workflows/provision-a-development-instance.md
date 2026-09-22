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
it performs — independently, one gate per wrapper. This is in addition to, never
instead of, the admin-session authorization the wizard's own actions require.

The gate starts from the same predicate the rest of the codebase uses
(`isAppDevelopmentMode()` / `getAppRuntimeMode()`, reading `CINATRA_RUNTIME_MODE`
/ `APP_RUNTIME_MODE`) and then asks for more than it. That predicate is a
two-value projection: every spelling that is not `production` or `prod` reads as
development. Right for a feature switch, too generous for a setup command that
writes — so the gate recognises its development instances **by name** and fails
closed on everything else:

- a **declared** runtime mode is accepted as `development`, any letter case,
  surrounding blanks trimmed. That is the one spelling every strict
  development-only switch in the codebase tests for, so it is exactly what the
  gate accepts. Any other declared value — a short form such as `dev`,
  `staging`, `preview`, a misspelling of `development` — is refused, under every
  build. The shared reading accepts `prod` beside `production` only because the
  strict switches are negative tests (`!== "development"`), so a short form
  still turns every development path off; a short *development* form is the
  opposite, a positive miss, and the gate does not recognise one.
- an **undeclared** runtime mode keeps parity with the shared reading, which
  defaults it to development explicitly: it is accepted whenever the build is
  not a production one, and refused under `NODE_ENV=production`, where "nobody
  declared a mode" is an ambiguity rather than a development instance. A blank
  value is not a declaration.
- a declared `development` still passes under a production build — a developer
  running one locally is exactly who this command is for.

This is the one point where the gate disagrees with the app about which runtime
it is in, and it disagrees only in the closed direction: it refuses runtimes the
shared reading would call development, and never accepts one the shared reading
calls production.

A refusal names the variable and the spellings the command accepts; it never
repeats the declared value back.

`cinatra install --mode demo` is unaffected. A demo instance runs with
`CINATRA_RUNTIME_MODE=development` and carries its overlay on the separate
`CINATRA_INSTALL_PROFILE` axis (`src/lib/install-profile.ts`), so it is a
development instance here like any other.

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
