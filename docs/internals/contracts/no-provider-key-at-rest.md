# No provider credential at rest under `docker/`

**Status:** enforced. **Gate:** `scripts/ci/no-keys-in-docker-tree.mjs` (the
`No Provider Key Under docker/` step of the `gates` workflow), plus
`scripts/ci/__tests__/no-keys-in-docker-tree.test.mjs` and
`scripts/__tests__/gen-graphiti-env.test.mjs` in the root Vitest suite.

## The rule

**A container gets a credential from the process environment of the
`docker compose` command that creates it — never from a file in the tree. No
file under `docker/` may contain a key-shaped value, tracked or generated.**

`docker/graphiti/.graphiti.env` **is never present.** It is not written by a
bring-up, not written by setup, and not written by a lane. Every run of
`scripts/gen-graphiti-env.mjs` deletes a leftover one and says that it did — and
says it loudly when the file it removed carried a real credential, because a key
that was at rest on a disk has to be treated as exposed whatever happens to the
file afterwards.

## Why a file was the wrong home

The knowledge-graph indexer needs the provider key as an environment variable at
container start, and the app keeps that key in the database, not the shell. The
first fix for that resolved the key and wrote it, decrypted, into a 0600
gitignored file that the compose service read with `env_file:`.

That file had a lifetime nobody managed:

- it survived `docker compose down`, `make clean`, a branch switch, and a whole
  lane or dev teardown;
- nothing deleted it, so it outlived the reason it was written;
- rotating or disconnecting the key in the app did not remove the old value from
  the disk;
- and being gitignored, no gate could see it — a tracked-tree scan (which is
  what `product-tree-hygiene` is, deliberately) reported a clean tree.

## The road that replaced it

`scripts/gen-graphiti-env.mjs` resolves the key **in memory** and **runs the
compose command itself**, with the provider variables set in that child
process's environment:

```bash
npm run kg:up        # resolve, then `docker compose up -d graphiti` with the key set
npm run kg:refresh   # the same, with this checkout's compose scoping resolved first
npm run services     # brings the whole stack up, then ends with `kg:up`
```

`docker-compose.yml` declares each provider variable **value-less** under the
graphiti service's `environment:` — `NAME:` with nothing after it. Compose omits
such a variable from the container when it is unset rather than setting it to
the empty string, so `docker/graphiti/config.yaml`'s keyless-safe defaults still
apply to a bare `docker compose up`. Writing `${NAME:-}` instead would set the
empty string and override those defaults.

Consequences worth knowing before you are surprised by them:

- **A bare `docker compose up` brings the indexer up KEYLESS.** That is the
  designed behaviour: extraction is off, nothing reaches a vendor, and the app
  reports the state. Use `npm run kg:up` to bring it up with a key. There is no
  file to inspect instead — the state is in the generator's output and in the
  app.
- **A run that cannot READ the stored configuration and has NOTHING to offer
  recreates nothing.** If the database is not up, or the key will not decrypt,
  and no fallback is available, the generator leaves the running container
  exactly as it is and says why: recreating there would start it keyless and
  silently turn extraction off on a working install.
- **The legacy `OPENAI_API_KEY` fallback is the one exception, and it is
  announced.** "Could not read the stored configuration, but `OPENAI_API_KEY` is
  set" is the first-bring-up signature that fallback exists for, so it IS
  applied and the run says out loud that it used one. The consequence to know:
  an install that was already running on a stored key has just been moved onto
  the environment one, and it stays there until the next successful run — so
  re-run `npm run kg:refresh` once the database is up.
- **A whole-stack `up` starts the indexer keyless on purpose.** A value-less
  variable is taken from the environment of the compose process, so every
  provider name is stripped before that `up` and handed over afterwards by
  `kg:up`: `scripts/dev-compose-env.mjs` emits an `unset` line into the payload
  `make dev` and `npm run services` already eval, and `scripts/setup.sh`, which
  does not use that step, strips them itself with `env -u`. Without it a stray
  `OPENAI_API_KEY` in `.env.local` would reach the container without ever
  passing the app's resolver — the wrong vendor on an Anthropic install, or a
  key the operator disconnected in the app. The window this leaves is worth
  knowing: the whole-stack `up` recreates the indexer keyless, and if the
  `kg:up` that follows cannot read the stored configuration (a database that did
  not come up), it holds back and the indexer stays keyless until the next
  `npm run kg:refresh`. It says so when that happens.
- **The residual exposure is a credential in a process environment**, readable
  by the same user: this script, the `docker compose` child, and — because that
  is what handing a container a variable means — the container's own
  configuration, which the docker daemon keeps for the container's life
  (`docker inspect` shows it). That is inherent to configuring this image, which
  reads environment variables and nothing else, and it is the same exposure the
  CI proof tier accepts deliberately (`scripts/ci/works-after/graphiti.sh` hands
  the key by NAME, never in an argv). What the contract guarantees is exact:
  **nothing at rest in the tree, and nothing that outlives the container it was
  handed to.** `docker compose down` is the end of it; a running container is
  not, so rotating a key still means bringing the indexer up again.
- **The key is never handed to a child that would print it.** `docker compose
  config` renders every resolved value to stdout, so the generator refuses that
  subcommand through its `-- <command>` seam. Inspect the rendered configuration
  by running compose directly, where these variables are value-less.

## Dev boot and lane cleanup

Nothing to clean up. There is no generated credential file to delete after a dev
session, a lane, or a CI run:

| Path | State |
| --- | --- |
| `docker/graphiti/.graphiti.env` | **never present** — not written; a leftover is deleted on every generator run |
| `docker/graphiti/.graphiti.env.tmp-*` | **never present** — the old atomic-replace siblings are swept with it |
| anything else under `docker/` | must never contain a key-shaped value; the gate fails the build if it does |

The `.gitignore` entry for `docker/graphiti/.graphiti.env*` is kept as a
**backstop**, not as a description of something that exists: it names an
artifact that must never become committable if it is ever re-introduced.

## What is NOT done yet: `docker/wayflow/.wayflow.env`

The rule above is the rule for the whole subtree, and one file does not obey it
yet. `scripts/gen-wayflow-env.mjs` writes `docker/wayflow/.wayflow.env` (0600,
gitignored) with `CINATRA_BRIDGE_TOKEN` and, when `.env.local` states one,
`OPENAI_API_KEY` in clear — the same shape of artifact the knowledge-graph
indexer just stopped using, for the same reason (its service reads it with
`env_file:`).

So on a developer's machine that has run `npm run services` with an
`OPENAI_API_KEY` in `.env.local`, a LOCAL run of the gate flags that file. **That
is a true finding, not a false positive**, and it is not allowlisted here: the
file really does hold a credential at rest. CI is unaffected — a runner checks
out a fresh tree, so only the tracked half runs there — and moving that
generator onto the same environment road is the next step, not a silent
exception.

## If the gate fires

It names the file, the line, and the SHAPE that matched — never the value, since
CI logs are broadly readable. Fix it by moving the value onto the environment
road above. If what it flagged is genuinely not a credential, it is shaped
exactly like one: give it a shape that is not. The named sentinels in
`docker/graphiti/config.yaml` (`cinatra-no-extraction-provider-configured`,
`cinatra-local-embedder`) are the precedent — they read as an explanation
wherever they surface, and they match no key shape.

The key shapes themselves live in `scripts/lib/key-shaped-values.mjs`, mirroring
the runtime redactors in `src/lib/chat-capture/redact.ts`,
`src/lib/setup-readiness-saga.ts` and `src/lib/assistant-runtime/ports.ts`. A
prefix added to those belongs here too, so a value scrubbed at runtime is also
refused at rest.
