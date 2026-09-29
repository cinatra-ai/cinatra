# Provision a development instance in one command

Audience: people developing Cinatra itself. This is not product or
administration documentation.

## What it is for

Proving a change on a development instance normally begins with a browser
session through the setup wizard: create the first account, pick a namespace,
pick a model provider and type in its key, fill in the connector-service secret,
set the public origin the model provider calls back to — then restart, because
that origin is read once, at startup. Each of those steps takes a browser and a
person; the underlying writes take seconds.

`pnpm provision:dev-instance` performs the same five writes in one call, through
the **same writers** the five screens use. It writes no row shape of its own and
seals nothing with a codec of its own.

## Running it

Put the secrets in a file only you can read, and hand the command that file:

```
(umask 077; cat > secrets.json)
{"adminPassword":"…","providerApiKey":"…","connectorServiceSecretKey":"…"}
^D

pnpm provision:dev-instance -- \
  --admin-email operator@example.test \
  --admin-name "The Operator" \
  --namespace acme-dev \
  --display-name "Acme Development" \
  --provider anthropic \
  --public-origin https://acme.example < secrets.json

rm secrets.json
```

**Not** `echo '{"adminPassword":"…"}' | pnpm provision:dev-instance`: that writes
every secret in the document into your shell history, which is the one place
this command's whole argument surface exists to keep them out of. A leading
space or `HISTCONTROL` is a setting, not a guarantee.

Every argument is optional; a leg you leave out is a leg the command does not
touch. `--provider` accepts `openai` or `anthropic`.

## The first administrator

This is the step that used to need a browser even when nothing else did. The
wizard's Account step is a sign-up form, and the first account to register is
promoted to instance administrator by the product's own first-user bootstrap.

`--admin-email` names the address and `--admin-name` its display name; both are
ordinary arguments, because an address is not a secret. The **password** travels
on stdin as `adminPassword`, and there is no flag that could carry it —
`--admin-password` is refused, exactly like `--api-key`. Unlike every other
secret, it is stored **exactly as given**: a password is bytes, not a name, so
nothing trims it, and a blank one is refused rather than quietly dropped.

This leg asks a **stricter runtime gate** than its four siblings — see the
runtime-gate section below. Their writes can be undone by an operator; seating a
platform administrator on an instance that has nobody on it yet cannot.

What the leg does, and just as importantly what it does not:

- it creates the account through the **authentication library's own server-side
  sign-up**, so the password hashing, the password policy, the verification
  flags and every account-creation hook stay the product's;
- it then calls the product's own **first-user bootstrap** with the new
  account's id — the same one-shot a browser reaches on its first authenticated
  render. The leg writes no role, no membership and no organization row itself;
- on an instance that **already has a person on it**, it writes nothing, makes
  no account call, and reports that as an ordinary outcome — whether or not the
  address you gave is the one on file. It never says which addresses exist;
- a password this instance's policy refuses is refused by name of the **rule**
  it broke — the configured minimum or the configured maximum, both of which the
  authentication library enforces. The password itself never reaches a message,
  a cause, a log line or an outcome, and neither does a refusal that came back
  quoting it;
- it **ends the session the registration opened**. The library signs a new
  account in as part of registering it, because a browser is about to carry that
  session; a command is not a browser, so leaving it alive would leave a live
  platform-administrator session on the instance that nobody holds. The leg
  revokes it through the library's own single-session revoke, after the
  promotion — after, because the promotion writes the account's active
  organization onto its sessions. If that revoke fails, the command says so and
  fails: a session left behind is exactly the hazard.

The address is not shape-checked by the command. The product has no
account-address validator of its own to reuse, and the sign-up endpoint the leg
calls is the authority that refuses a malformed one.

If the first-user bootstrap itself *fails* part-way — it writes the role, the
default organization, the membership and the sessions' organization in turn —
the command still ends the session, then refuses: it names the account, says
that whether the account became an administrator is unknown and must be read on
the instance, and says what became of the session.

If the account is created but the instance declines to promote it, the command
says so and **exits non-zero**. An unattended caller reads the exit code, and an
instance whose operator has no administrator rights is not a provisioned one.

The leg runs **first**, which is the wizard's own order — the Account step is
step 1 of its rail. Nothing forces that from below: none of the other four legs
reads the current user, and the provider leg passes a null actor on purpose,
since no person worked the wizard. What the order buys is that every
intermediate state of this command is a state a wizard run also passes through.

## How secrets travel

Secret values — the provider key, the connector-service secret, the first
administrator's password — reach the running process **over stdin**, as a small
JSON document. They are:

- never a command-line argument — the parser has no flag that could carry one,
  and refuses a secret-looking flag rather than ignoring it (an ignored
  `--api-key` is still a key in the shell history and in `ps`);
- never written to an environment file on disk;
- never logged — the command reports only whether a secret was supplied.

Recognised keys: `providerApiKey`, `providerProjectId`,
`providerOrganizationId`, `connectorServiceSecretKey`, `connectorServiceUrl`,
`adminPassword`.

Each value — **except the administrator password** — is sealed by the exact
encryption call the corresponding screen already uses before anything is
persisted. A password is not sealed at all: it is **hashed**, one way, by the
authentication library's own registration path, exactly as it would be for an
account created in a browser. Nothing stores it, and nothing can read it back.

## The runtime gate

The command refuses to run outside a development runtime, and so does each write
it performs — independently, one gate per wrapper. This is in addition to, never
instead of, the admin-session authorization the wizard's own actions require.

There are **two** gates. They judge a declared runtime mode by the same rule,
and differ in one case only.

Both start from the same predicate the rest of the codebase uses
(`isAppDevelopmentMode()` / `getAppRuntimeMode()`, reading `CINATRA_RUNTIME_MODE`
/ `APP_RUNTIME_MODE`) and then ask for more than it. That predicate is a
two-value projection: every spelling that is not `production` or `prod` reads as
development. Right for a feature switch, too generous for a setup command that
writes — so the gates recognise their development instances **by name** and fail
closed on everything else.

The **shared gate** (`assertDevelopmentRuntime`) is what the command itself and
the four legs an operator can undo ask for:

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

The **strict gate** (`assertDeclaredDevelopmentRuntime`) is asked by the
first-administrator leg alone. It calls the shared gate first — so a declared
mode is judged by the rule above, `development` and nothing else — and then adds
the one requirement the shared gate deliberately does not make: the mode has to
have been **declared**. An undeclared mode, which the shared gate accepts
whenever the build is not a production one, is refused here by name of the
variables to set and the spelling they accept.

Why the difference: the four legs below write a namespace, a connector-service
secret, a public origin and a provider connection, and an operator can undo any
of them. Seating a platform administrator on an instance that has nobody on it
yet cannot be undone, so that one write asks the instance to have said which
runtime it is rather than resting on the default.

A refusal from either gate names the variable and the spellings the command
accepts; it never repeats the declared value back.

Nothing normal meets either refusal: `.env.example` ships
`CINATRA_RUNTIME_MODE=development`, and `scripts/setup.sh` normalises an
install's mode to exactly `development` or `production`. The codebase already
turns on strict `RUNTIME_MODE === "development"` in dozens of places —
`install-profile.ts` records why there is deliberately no third runtime value —
so these gates join that convention rather than inventing one.

`cinatra install --mode demo` is unaffected. A demo instance runs with
`CINATRA_RUNTIME_MODE=development` and carries its overlay on the separate
`CINATRA_INSTALL_PROFILE` axis (`src/lib/install-profile.ts`), so it is a
development instance here like any other.

## Which writer each leg reuses

| Leg | Screen | Writer reused |
| --- | --- | --- |
| First administrator | `/setup/account` | the authentication library's own server-side sign-up (the in-process twin of the endpoint the step's form posts to), then the product's own first-user bootstrap for the promotion, then the library's own single-session revoke for the session the sign-up opened |
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

## The agent definitions are not this command's

This command does not read the git-native agent definitions into the database,
and it cannot. The loader that writes those rows goes through the agent-template
store (`packages/agents/src/store.ts`), which reads the instance's authorization
policy (`packages/agents/src/auth-policy.ts`), and that module resolves the
request-scoped session and the account screens. Its graph belongs to the
application's own build, and importing it from a plain Node process fails — by
one of two different mechanisms, depending on which process:

- under **this command's** runtime (`--conditions=react-server`) the module's
  `import "server-only"` marker is inert, because that package's export map sends
  the `react-server` condition to an empty module. What fires instead is Next's
  client router context, reached through the account screens: `createContext is
  not a function`, because the same condition resolves `react` to the build that
  has no such export.
- under a runtime **without** that condition the marker itself fires, which is
  what it is for.

Either way the failure comes before the first definition is read.

The development boot does it instead, in an awaited `dev-agent-ingest` phase. In
development the boot is detached from `register()`
(`src/lib/boot/register-await-policy.ts`), so the server serves while it runs;
what awaiting the phase moves is the READY marker, which now comes after the
definitions are on file. `/api/health` answers `starting` / 503 until then. One
start after this command therefore reaches a complete instance, and a second
start buys nothing.

## Idempotency

Running the command twice with the same input performs no additional database
write and makes no additional external call. Each leg reports whether it wrote.

## Tests

- unit tier (`pnpm test:root`): the runtime gate, the shape claim that every
  wrapper gates itself, the argument surface (no secret-bearing flag), and the
  first-administrator leg — the refusal before any read, the single sign-up
  call, the promotion through the product's own bootstrap, the already-seated
  outcome, and the password's absence from every message, cause and outcome.
- real-database tier: `SUPABASE_DB_URL='…' pnpm test:dev-instance-provisioning`
  — row equality against the screens' own writers, the refusal with zero writes,
  and a composed run and idempotency **for the four older legs only**. It does
  not reach the first-administrator leg: that tier requests no administrator, so
  nothing in it imports or runs one. Two prerequisites: a reachable development
  Postgres, and the development extensions materialised
  (`node scripts/ci/sync-dev-extensions.mjs --pinned`), because the
  connector-secret row equality is asserted against the connector's own
  `saveNangoSettings` — the same way the tracked connector action-gate suites
  read those sources.
